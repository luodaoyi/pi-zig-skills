import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const ZLS_RELEASE = "0.16.0";

function log(message: string): void {
  console.error("[pi-zig-skills] " + message);
}

export function isOfficialZls016(versionText: string): boolean {
  const match = String(versionText).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  if (/dev|git|dirty|nightly/i.test(versionText)) return false;
  return match[1] === "0" && match[2] === "16";
}

export function zlsAssetName(platform = process.platform, arch = process.arch): { name: string; archive: "tar.xz" | "zip" } {
  const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch === "ia32" ? "x86" : arch === "arm" ? "arm" : arch === "loong64" ? "loongarch64" : arch === "riscv64" ? "riscv64" : arch === "s390x" ? "s390x" : arch === "ppc64" ? "powerpc64le" : null;
  if (!os || !cpu) throw new Error("unsupported platform for official zls " + ZLS_RELEASE + ": " + platform + "/" + arch);
  const archive = os === "windows" ? "zip" : "tar.xz";
  return { name: "zls-" + cpu + "-" + os + "." + archive, archive };
}

function zlsBinName(): string {
  return process.platform === "win32" ? "zls.exe" : "zls";
}

function cacheRoot(): string {
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "pi-zig-skills");
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    return path.join(base, "pi-zig-skills");
  }
  return path.join(homedir(), ".cache", "pi-zig-skills");
}

function cachedZlsPath(): string {
  return path.join(cacheRoot(), "zls-" + ZLS_RELEASE, zlsBinName());
}

function runVersion(bin: string): string | undefined {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 8000 });
  if (result.status !== 0) return undefined;
  return (result.stdout || "") + "\n" + (result.stderr || "");
}

function whichZls(): string | undefined {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(cmd, ["zls"], { encoding: "utf8", timeout: 8000 });
  if (result.status !== 0) return undefined;
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function peekZigVersion(): string | undefined {
  const result = spawnSync("zig", ["version"], { encoding: "utf8", timeout: 8000 });
  if (result.status !== 0) return undefined;
  const text = (result.stdout || "").trim();
  return text || undefined;
}

function prependPath(dir: string): void {
  const sep = path.delimiter;
  const resolved = path.resolve(dir);
  const parts = (process.env.PATH || "").split(sep).filter(Boolean).filter((entry) => path.resolve(entry) !== resolved);
  process.env.PATH = [resolved, ...parts].join(sep);
}

function findZlsBinary(root: string): string | undefined {
  const want = zlsBinName();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (name !== "." && name !== "..") stack.push(full);
      } else if (name === want || name === "zls") {
        return full;
      }
    }
  }
  return undefined;
}

function extractArchive(archivePath: string, dest: string, kind: "tar.xz" | "zip"): void {
  mkdirSync(dest, { recursive: true });
  if (kind === "zip") {
    const result = process.platform === "win32"
      ? spawnSync("powershell", ["-NoProfile", "-Command", "Expand-Archive -Force -Path " + JSON.stringify(archivePath) + " -DestinationPath " + JSON.stringify(dest)], { encoding: "utf8" })
      : spawnSync("unzip", ["-o", archivePath, "-d", dest], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("unzip failed: " + (result.stderr || result.stdout || result.status));
    return;
  }
  const result = spawnSync("tar", ["-xJf", archivePath, "-C", dest], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("tar extract failed: " + (result.stderr || result.stdout || result.status));
}

async function fetchOfficialZls(): Promise<string> {
  const dest = cachedZlsPath();
  if (existsSync(dest)) {
    const cached = runVersion(dest);
    if (cached && isOfficialZls016(cached)) return dest;
  }
  const spec = zlsAssetName();
  const host = "https://" + "github.com/" + "zigtools/zls/releases/" + "download/";
  const url = host + ZLS_RELEASE + "/" + spec.name;
  log("getting official zls " + ZLS_RELEASE + " (" + spec.name + ")");
  const response = await fetch(url, { headers: { "User-Agent": "pi-zig-skills" }, redirect: "follow" });
  if (!response.ok) throw new Error("get failed " + response.status + " " + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const work = mkdtempSync(path.join(tmpdir(), "pi-zig-skills-zls-"));
  try {
    const archivePath = path.join(work, spec.name);
    writeFileSync(archivePath, bytes);
    const extracted = path.join(work, "out");
    extractArchive(archivePath, extracted, spec.archive);
    const found = findZlsBinary(extracted);
    if (!found) throw new Error("archive " + spec.name + " did not contain zls");
    const verified = runVersion(found);
    if (!verified || !isOfficialZls016(verified)) throw new Error("binary is not zls 0.16.x: " + (verified || "no version"));
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(found, dest);
    if (process.platform !== "win32") chmodSync(dest, 0o755);
    return dest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function resolveZls016(): Promise<string> {
  const zig = peekZigVersion();
  if (zig) log("zig version: " + zig);
  const onPath = whichZls();
  if (onPath) {
    const text = runVersion(onPath);
    if (text && isOfficialZls016(text)) {
      log("using PATH zls 0.16.x at " + onPath);
      return path.resolve(onPath);
    }
    if (text) log("PATH zls is not 0.16.x (" + text.trim() + "); using official " + ZLS_RELEASE);
  }
  const cached = cachedZlsPath();
  if (existsSync(cached)) {
    const text = runVersion(cached);
    if (text && isOfficialZls016(text)) {
      log("using cached official zls at " + cached);
      return cached;
    }
  }
  const installed = await fetchOfficialZls();
  log("official zls " + ZLS_RELEASE + " ready at " + installed);
  return installed;
}

export default async function (): Promise<void> {
  try {
    const zls = await resolveZls016();
    prependPath(path.dirname(zls));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("failed to ensure zls 0.16: " + message);
  }
}
