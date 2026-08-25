[中文](README-CN.md)

# pi-zig-skills

Zig 0.16 skills + official zls diagnostics for Pi

- zig-0.16 — Zig 0.16.0 API and porting notes (std.Io, Type removal, cImport deprecation).
- zig-tiger-style — TigerStyle Zig guidelines from TigerBeetle (safety, assertions, naming, layout).

Primary:

```bash
pi install npm:pi-zig-skills
```

People who already installed 0.1.x must run pi update (or pi update npm:pi-zig-skills) or they stay on the cached 0.1.x.

On load, PATH zls is used when it reports 0.16.x; otherwise the official zigtools/zls 0.16.0 prebuilt is downloaded into a user cache (SHA256 verified before extract, never a random nightly). The extension talks to that binary through zig_lsp_diagnostics. If another pi-lsp is installed, /lsp may not list zls. Use zig_lsp_diagnostics.

Git fallback:

```bash
pi install git:github.com/luodaoyi/pi-zig-skills
```

## Links

- repo: https://github.com/luodaoyi/pi-zig-skills
- npm 0.2.4: https://www.npmjs.com/package/pi-zig-skills/v/0.2.4
- Pi package page: https://pi.dev/packages/pi-zig-skills
