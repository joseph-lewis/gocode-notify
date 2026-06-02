# Changelog

All notable changes to `@trygocode/notify` are documented here. This project
follows [Semantic Versioning](https://semver.org).

## [0.1.1] — 2026-06-03

### Changed
- **Real GoCode artwork** — replaced placeholder mark with the official GoCode
  Notify icon (`icon-512.png` / `icon-128.png`) and a README hero banner. MCP
  server `icons` metadata now points at the real PNGs.
- **Clearer docs** — the free GoCode phone app is now called out up front as a
  required component, the "free" status is stated explicitly, and a new
  **GoCode platform settings** section documents auto-push, safe pull-before-push,
  AI-Solve conflict resolution, and review-&-merge.
- Renamed "Ralph / Homer loops" to "Ralph Wiggum / Autopilot script loops"
  throughout for readers unfamiliar with the internal codenames.

## [0.1.0] — 2026-06-03

Initial public release.

### Added
- **One-command install** — `npx @trygocode/notify@latest setup` pairs the machine,
  auto-detects your agent runtimes, and merges hooks + the MCP server + an
  anti-double-ping rule into each (Cursor, Claude Code, OpenCode). Idempotent;
  safe to re-run; `--force` re-pairs.
- **Three notification triggers** — (A) runtime hooks (Cursor `stop`; Claude Code
  `Stop` / `Notification` / `SubagentStop`), (B) the `gocode_notify` MCP tool for
  explicit "ping me when X is done" requests, (C) an opt-in Ralph/Homer loop
  completion/halt snippet.
- **Secure pairing** — a short-lived 6-digit code is exchanged for a scoped,
  push-only API key stored locally (`~/.gocode/credentials`, chmod 600). The key
  can only send pushes to your own phone; revoke any time from the app.
- **Offline outbox** — sends made while the server is unreachable are queued and
  flushed best-effort later, so a blocked agent is never caused by a slow push.
- **`status` self-diagnosis**, `test` round-trip push, and a clean `uninstall`
  that removes exactly what this tool added.
- **MCP server metadata** — `icons` + `websiteUrl` (SEP-973) so compatible clients
  can show the GoCode mark next to the server.

[0.1.1]: https://github.com/joseph-lewis/gocode-notify/releases/tag/v0.1.1
[0.1.0]: https://github.com/joseph-lewis/gocode-notify/releases/tag/v0.1.0
