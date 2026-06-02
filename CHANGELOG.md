# Changelog

All notable changes to `@gocode/notify` are documented here. This project
follows [Semantic Versioning](https://semver.org).

## [0.1.0] — 2026-06-03

Initial public release.

### Added
- **One-command install** — `npx @gocode/notify@latest setup` pairs the machine,
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

[0.1.0]: https://github.com/joseph-lewis/gocode-notify/releases/tag/v0.1.0
