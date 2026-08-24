import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const ZLS_RELEASE = "0.16.0";

/** Official zigtools/zls 0.16.0 GitHub Release asset SHA256 digests (https://github.com/zigtools/zls/releases/tag/0.16.0). */
export const ZLS_ASSET_SHA256: Readonly<Record<string, string>> = {
  "zls-aarch64-linux.tar.xz": "430cd293d201eb70ae2519dbc96c854bf8791b8df7fc9392e8d2dc9680a2bed7",
  "zls-aarch64-macos.tar.xz": "b93ec549f8558a7e85984a840e9276d274f1059b54ade4254296ef4982958359",
  "zls-aarch64-windows.zip": "ef4c5ccb93c80c9f023105c5f558ae8774ac6668d560ba6f92a2f87d95df2311",
  "zls-arm-linux.tar.xz": "7cf8d11f914127809b89254ad97e4b96d84294370418954a49b78bd623d3c55e",
  "zls-loongarch64-linux.tar.xz": "91128eb73e475cb85f81c40182cb6ce24457b29c857ceb8619205e6cc4bc7b96",
  "zls-powerpc64le-linux.tar.xz": "d51289187aaa892eb266baaa6c1d7f2a30f6d195eaa295c6f54eef17214f03fa",
  "zls-riscv64-linux.tar.xz": "2764ac1303a5b398569df0e8702c6f6ef86da915aeff4bf9dd0c22bc55324288",
  "zls-s390x-linux.tar.xz": "e4f4dda6fbd9311f86fcc81480ee2fa9bb28697376669173a825cc67711a635a",
  "zls-wasm32-wasi.tar.xz": "e992d135d74468ac6bac2907ce31092b2ad24a2faa8ef4e93d1131a51666fd0a",
  "zls-x86-linux.tar.xz": "2f7965da884d74d9f7e8b8ef1208ae137084680ddf8580473ff412f62a4051a8",
  "zls-x86-windows.zip": "ecb2870979b35143aa5e7ce92d3b69362a76fd7126c8f950a5f8a7f99a77416f",
  "zls-x86_64-linux.tar.xz": "ded6d562a0b86ee878b1ddf70ffab2797ce3cdca3b02d6077548f9d56dff96b6",
  "zls-x86_64-macos.tar.xz": "49f716ea96c1aadaecaa5d9c0a50874cbcf443dc42b825f1e7ee35499ad3eb96",
  "zls-x86_64-windows.zip": "35cbb7163224e8cf92d21099c1b1391f2aba927f25d389f021b13a21d40b96dd",
};

export const REQUIRED_ZLS_SHA256_ASSETS = [
  "zls-x86_64-linux.tar.xz",
  "zls-aarch64-linux.tar.xz",
  "zls-x86_64-macos.tar.xz",
  "zls-aarch64-macos.tar.xz",
  "zls-x86_64-windows.zip",
  "zls-aarch64-windows.zip",
] as const;

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

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function pinnedSha256Equals(expectedHex: string, actualHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHex) || !/^[0-9a-f]{64}$/.test(actualHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(actualHex, "hex"));
}

export function assertRequiredZlsPins(): void {
  for (const name of REQUIRED_ZLS_SHA256_ASSETS) {
    const hex = ZLS_ASSET_SHA256[name];
    if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error("invalid or missing zls sha256 pin for " + name);
    }
  }
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

function cachedSha256Marker(): string {
  return path.join(cacheRoot(), "zls-" + ZLS_RELEASE, "sha256");
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

function cachedOfficialIsVerified(): boolean {
  const dest = cachedZlsPath();
  const marker = cachedSha256Marker();
  if (!existsSync(dest) || !existsSync(marker)) return false;
  const expected = ZLS_ASSET_SHA256[zlsAssetName().name];
  if (!expected) return false;
  const stored = readFileSync(marker, "utf8").trim().toLowerCase();
  if (!pinnedSha256Equals(expected, stored)) return false;
  const cached = runVersion(dest);
  return !!(cached && isOfficialZls016(cached));
}

async function fetchOfficialZls(): Promise<string> {
  const dest = cachedZlsPath();
  if (cachedOfficialIsVerified()) return dest;
  const spec = zlsAssetName();
  const expected = ZLS_ASSET_SHA256[spec.name];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("no pinned sha256 for official zls " + ZLS_RELEASE + " asset " + spec.name);
  }
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
    const actual = sha256Hex(bytes);
    if (!pinnedSha256Equals(expected, actual)) {
      throw new Error(
        "sha256 mismatch for " + spec.name + ": expected " + expected + " got " + actual + "; refusing extract of unverified bytes"
      );
    }
    const extracted = path.join(work, "out");
    extractArchive(archivePath, extracted, spec.archive);
    const found = findZlsBinary(extracted);
    if (!found) throw new Error("archive " + spec.name + " did not contain zls");
    const verified = runVersion(found);
    if (!verified || !isOfficialZls016(verified)) throw new Error("binary is not zls 0.16.x: " + (verified || "no version"));
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(found, dest);
    if (process.platform !== "win32") chmodSync(dest, 0o755);
    writeFileSync(cachedSha256Marker(), expected + "\n");
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
  if (cachedOfficialIsVerified()) {
    const cached = cachedZlsPath();
    log("using cached official zls at " + cached);
    return cached;
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
