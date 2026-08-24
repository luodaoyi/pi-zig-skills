[English](README.md)

# pi-zig-skills

Pi 包：两个 skill，以及一个小扩展——解析官方 zls 0.16，并为 .zig / .zon 注册 zig_lsp_diagnostics。加入后会自动出现，无需手动复制。

- zig-0.16 — Zig 0.16.0 API 与移植说明（std.Io、移除 Type、cImport 弃用）。
- zig-tiger-style — 来自 TigerBeetle 的 TigerStyle Zig 指南（安全、断言、命名、布局）。

主要安装方式：

```bash
pi install npm:pi-zig-skills
```

已经安装 0.1.x 的用户必须运行 pi update（或 pi update npm:pi-zig-skills），否则会一直停留在缓存的 0.1.x。

加载时：若 PATH 上的 zls 报告为 0.16.x，则使用它；否则会把官方 zigtools/zls 0.16.0 预编译包下载到用户缓存（解压前校验 SHA256，不会使用随机 nightly）。扩展通过 zig_lsp_diagnostics 与该二进制通信。若已安装其他 pi-lsp，/lsp 可能不会列出 zls。请使用我们的 zig_lsp_diagnostics。

Git 备用：

```bash
pi install git:github.com/luodaoyi/pi-zig-skills
```

链接：

- 仓库：https://github.com/luodaoyi/pi-zig-skills
- npm 0.2.2：https://www.npmjs.com/package/pi-zig-skills/v/0.2.2
- pi.dev 图库：https://pi.dev/packages/pi-zig-skills
