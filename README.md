# pi-zig-skills

Pi package with two skills and a small extension that makes a Zig 0.16-matching zls available for @narumitw/pi-lsp (lsp_diagnostics on .zig / .zon). After they are added they show up automatically; no manual copy.

- `zig-0.16` — Zig 0.16.0 API and porting notes (`std.Io`, `@Type` removal, `@cImport` deprecation).
- `zig-tiger-style` — TigerStyle Zig guidelines from TigerBeetle (safety, assertions, naming, layout).

Primary:

```bash
pi install npm:pi-zig-skills
```

That one command installs the skills and the bundled pi-lsp tools. On load, PATH `zls` is used when it reports 0.16.x; otherwise the official zigtools/zls 0.16 prebuilt is downloaded into a user cache (never a random nightly) so pi-lsp default `zls` command can run. People who already installed 0.1.x must run `pi update` (or `pi update npm:pi-zig-skills`) or they stay on the cached 0.1.x.

Git fallback:

```bash
pi install git:github.com/luodaoyi/pi-zig-skills
```
