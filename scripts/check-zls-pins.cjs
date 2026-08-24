const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "../extensions/zls/index.ts"), "utf8");
const mapMatch = src.match(/export const ZLS_ASSET_SHA256[\s\S]*?=\s*\{([\s\S]*?)\}\s*;/);
if (!mapMatch) {
  console.error("ZLS_ASSET_SHA256 map not found");
  process.exit(1);
}
const pins = {};
for (const m of mapMatch[1].matchAll(/"([^"]+)":\s*"([0-9a-f]{64})"/g)) pins[m[1]] = m[2];
const required = [
  "zls-x86_64-linux.tar.xz",
  "zls-aarch64-linux.tar.xz",
  "zls-x86_64-macos.tar.xz",
  "zls-aarch64-macos.tar.xz",
  "zls-x86_64-windows.zip",
  "zls-aarch64-windows.zip",
];
if (required.length !== 6) {
  console.error("unit check must cover exactly 6 platform keys");
  process.exit(1);
}
for (const name of required) {
  if (!pins[name] || !/^[0-9a-f]{64}$/.test(pins[name])) {
    console.error("missing or invalid sha256 pin for " + name);
    process.exit(1);
  }
}
console.log("zls sha256 pins ok (" + required.length + " required, " + Object.keys(pins).length + " pinned)");
