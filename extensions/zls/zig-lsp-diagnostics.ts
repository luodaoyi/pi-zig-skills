import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

export const ZIG_LSP_DIAGNOSTICS_TOOL = "zig_lsp_diagnostics";

const SKIP = new Set([".git", ".hg", ".zig-cache", "zig-cache", "zig-out", "node_modules"]);
const EXTS = new Set([".zig", ".zon"]);
const DEFAULT_LIMIT = 50;
const TIMEOUT_MS = 25_000;
const PUSH_GRACE_MS = 5_000;

type Diagnostic = {
  range: { start: { line: number; character: number } };
  severity?: number;
  source?: string;
  code?: string | number;
  message: string;
};

function resolveRoot(root?: string): string {
  const resolved = path.resolve((root || process.cwd()).trim() || process.cwd());
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error("workspace root is not a directory: " + resolved);
  }
  return resolved;
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function collectFiles(root: string, requested: string[] | undefined, limit: number): string[] {
  const cap = Math.max(1, Math.floor(limit));
  const files: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const realRoot = realpathSync(root);
  const inputs = requested?.length ? requested : [root];

  const walk = (target: string) => {
    if (files.length >= cap || !existsSync(target)) return;
    const real = realpathSync(target);
    if (!inside(realRoot, real)) return;
    const st = statSync(target);
    if (st.isFile()) {
      if (EXTS.has(path.extname(target)) && !seen.has(target)) {
        seen.add(target);
        files.push(target);
      }
      return;
    }
    if (!st.isDirectory() || visited.has(real)) return;
    visited.add(real);
    const entries = readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= cap) break;
      if ((entry.isDirectory() || entry.isSymbolicLink()) && SKIP.has(entry.name)) continue;
      walk(path.join(target, entry.name));
    }
  };

  for (const input of inputs) {
    const target = path.resolve(root, input);
    if (!existsSync(target)) throw new Error("requested path does not exist: " + target);
    if (!inside(realRoot, realpathSync(target))) throw new Error("requested path is outside workspace: " + target);
    walk(target);
    if (files.length >= cap) break;
  }
  return files;
}

function directoryUri(dir: string): string {
  return pathToFileURL(dir.endsWith(path.sep) ? dir : dir + path.sep).href;
}

class ZlsStdio {
  #child: ReturnType<typeof spawn> | undefined;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #published = new Map<string, Diagnostic[]>();
  #waiters = new Map<string, Array<(d: Diagnostic[]) => void>>();
  #stderr = "";
  #caps: any = {};
  #bin: string;
  #cwd: string;

  constructor(bin: string, cwd: string) {
    this.#bin = bin;
    this.#cwd = cwd;
  }

  async start(): Promise<void> {
    const child = spawn(this.#bin, [], { cwd: this.#cwd, stdio: "pipe" });
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString();
    });
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      this.#fail("zls exited (" + (signal || code) + ")");
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => reject(new Error("zls failed to start: " + err.message)));
    });
  }

  async initialize(root: string): Promise<void> {
    const rootUri = directoryUri(root);
    const response = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(root) || "workspace" }],
      capabilities: {
        textDocument: {
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
          publishDiagnostics: {},
          synchronization: { didSave: true },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    });
    this.#caps = response.result?.capabilities ?? {};
    this.notify("initialized", {});
  }

  didOpen(uri: string, text: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "zig", version: 1, text },
    });
  }

  async diagnostics(uri: string): Promise<Diagnostic[]> {
    if (this.#caps.diagnosticProvider) {
      const response = await this.request("textDocument/diagnostic", { textDocument: { uri } });
      const items = response.result?.items;
      // zls often answers pull immediately with items: []. That is not final;
      // real errors arrive later via textDocument/publishDiagnostics.
      if (Array.isArray(items) && items.length > 0) return items;
    }
    return await this.#waitForPushDiagnostics(uri);
  }

  #waitForPushDiagnostics(uri: string): Promise<Diagnostic[]> {
    const existing = this.#published.get(uri);
    if (existing && existing.length > 0) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const finish = (d: Diagnostic[]) => {
        clearTimeout(timer);
        const list = this.#waiters.get(uri);
        if (list) {
          const next = list.filter((fn) => fn !== onPub);
          if (next.length) this.#waiters.set(uri, next);
          else this.#waiters.delete(uri);
        }
        resolve(d);
      };
      const timer = setTimeout(() => {
        finish(this.#published.get(uri) ?? []);
      }, Math.min(PUSH_GRACE_MS, TIMEOUT_MS));
      const onPub = (d: Diagnostic[]) => {
        if (d.length === 0) return;
        finish(d);
      };
      const list = this.#waiters.get(uri) ?? [];
      list.push(onPub);
      this.#waiters.set(uri, list);
    });
  }

  async shutdown(): Promise<void> {
    try {
      if (this.#child) {
        await this.request("shutdown", null);
        this.notify("exit", undefined);
      }
    } catch {
      /* ignore */
    } finally {
      this.close();
    }
  }

  close(): void {
    this.#fail("zls request cancelled");
    if (this.#child && !this.#child.killed) this.#child.kill("SIGTERM");
    this.#child = undefined;
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("zls request timed out: " + method + this.#err()));
      }, TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  #send(message: object): void {
    if (!this.#child) throw new Error("zls is not running");
    const body = JSON.stringify(message);
    this.#child.stdin.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const sep = this.#buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.#buffer.subarray(0, sep).toString("utf8");
      const len = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!len) throw new Error("invalid zls header");
      const start = sep + 4;
      const n = Number(len);
      if (this.#buffer.length < start + n) return;
      const raw = this.#buffer.subarray(start, start + n).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + n);
      this.#handle(JSON.parse(raw));
    }
  }

  #handle(message: any): void {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error("zls error: " + message.error.message + this.#err()));
      else pending.resolve(message);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const uri = message.params?.uri;
      const diagnostics = message.params?.diagnostics ?? [];
      if (uri) {
        this.#published.set(uri, diagnostics);
        const waiters = this.#waiters.get(uri);
        if (waiters && waiters.length) {
          // Keep waiters on empty publish so a later analysis result can settle.
          if (diagnostics.length > 0) {
            this.#waiters.delete(uri);
            for (const w of waiters) w(diagnostics);
          }
        }
      }
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      if (message.method === "workspace/configuration") {
        const items = message.params?.items ?? [];
        this.#send({ jsonrpc: "2.0", id: message.id, result: items.map(() => ({})) });
        return;
      }
      if (message.method === "workspace/workspaceFolders") {
        this.#send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{ uri: directoryUri(this.#cwd), name: path.basename(this.#cwd) || "workspace" }],
        });
        return;
      }
      this.#send({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }

  #fail(message: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message + this.#err()));
      this.#pending.delete(id);
    }
  }

  #err(): string {
    const s = this.#stderr.trim();
    return s ? "\nServer stderr:\n" + s : "";
  }
}

function severityName(severity?: number): string {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "info";
  if (severity === 4) return "hint";
  return "diagnostic";
}

function formatEntries(root: string, zls: string, entries: Array<{ file: string; diagnostics: Diagnostic[] }>): string {
  const lines = entries.flatMap((entry) => {
    const rel = path.relative(root, entry.file) || entry.file;
    if (entry.diagnostics.length === 0) return [rel + ": no diagnostics"];
    return entry.diagnostics.map((d) => {
      const line = (d.range?.start?.line ?? 0) + 1;
      const col = (d.range?.start?.character ?? 0) + 1;
      const source = d.source ?? "zls";
      const code = d.code === undefined ? "" : " " + d.code;
      return rel + ":" + line + ":" + col + ": " + severityName(d.severity) + " " + source + code + ": " + d.message;
    });
  });
  const count = entries.reduce((n, e) => n + e.diagnostics.length, 0);
  return [
    "zls LSP diagnostics via " + ZIG_LSP_DIAGNOSTICS_TOOL + " (" + zls + "): " + count + " diagnostic(s) across " + entries.length + " file(s).",
    "",
    ...lines,
  ].join("\n");
}

export async function runZigLspDiagnostics(
  zlsBin: string,
  params: { paths?: string[]; root?: string; limit?: number },
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
  const root = resolveRoot(params.root);
  const files = collectFiles(root, params.paths, params.limit ?? DEFAULT_LIMIT);
  if (files.length === 0) {
    return {
      content: [{ type: "text", text: ZIG_LSP_DIAGNOSTICS_TOOL + " found no .zig/.zon files." }],
      details: { root, zls: zlsBin, files: [] },
    };
  }
  const client = new ZlsStdio(zlsBin, root);
  const abort = () => client.close();
  if (signal?.aborted) throw new Error("zig_lsp_diagnostics aborted");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.start();
    await client.initialize(root);
    const opened: Array<{ file: string; uri: string }> = [];
    try {
      for (const file of files) {
        if (signal?.aborted) throw new Error("zig_lsp_diagnostics aborted");
        const uri = pathToFileURL(file).href;
        client.didOpen(uri, readFileSync(file, "utf8"));
        opened.push({ file, uri });
      }
      await new Promise((r) => setTimeout(r, PUSH_GRACE_MS));
      const entries = [];
      for (const { file, uri } of opened) {
        entries.push({ file, diagnostics: await client.diagnostics(uri) });
      }
      return {
        content: [{ type: "text", text: formatEntries(root, zlsBin, entries) }],
        details: { root, zls: zlsBin, files: entries.map((e) => path.relative(root, e.file) || e.file) },
      };
    } finally {
      /* client.shutdown closes */
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.shutdown();
  }
}

export function registerZigLspDiagnostics(pi: { registerTool: (tool: object) => void }, resolveZls: () => Promise<string>): void {
  pi.registerTool({
    name: ZIG_LSP_DIAGNOSTICS_TOOL,
    label: "Zig LSP Diagnostics",
    description:
      "Run official zls 0.16 diagnostics on .zig/.zon files. Use this tool even if /lsp belongs to another pi-lsp and does not list zls.",
    promptSnippet: "Get Zig diagnostics from the package-resolved official zls 0.16 via zig_lsp_diagnostics",
    promptGuidelines: [
      "Use zig_lsp_diagnostics for Zig (.zig/.zon) diagnostics.",
      "Do not depend on /lsp or lsp_diagnostics from another pi-lsp package.",
    ],
    parameters: Type.Object({
      paths: Type.Optional(
        Type.Array(Type.String(), { description: "Files or directories to check. Defaults to the workspace root." }),
      ),
      root: Type.Optional(Type.String({ description: "Workspace root. Defaults to cwd." })),
      limit: Type.Optional(Type.Number({ description: "Maximum .zig/.zon files to open. Defaults to 50." })),
    }),
    async execute(_toolCallId: string, params: { paths?: string[]; root?: string; limit?: number }, signal: AbortSignal) {
      const zls = await resolveZls();
      return runZigLspDiagnostics(zls, params, signal);
    },
  });
}
