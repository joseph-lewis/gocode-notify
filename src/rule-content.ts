// Shared rule/skill content (PRD §5.5 — anti-double-ping) — the single source of
// truth for the on-demand-notification guidance shipped into BOTH clients:
//
//   • Claude Code → `~/.claude/skills/gocode-notify/SKILL.md`
//   • Cursor      → `~/.cursor/rules/gocode-notify.md`
//
// The body is identical for both clients; only two things differ per client:
//   1. The frontmatter block (Claude SKILL.md `name:`+`description:` vs Cursor
//      rule `description:`+`alwaysApply:`).
//   2. The parenthetical naming WHICH runtime hook owns the automatic pings
//      (Claude fires `Stop`+`Notification`+`SubagentStop`; Cursor fires `stop`).
//
// Centralising the prose here means the anti-double-ping invariant ("the hooks
// own the automatic done/idle/error pings — only call the MCP tool when the user
// EXPLICITLY asks") cannot silently drift between the two clients. `claude.ts`
// and `cursor.ts` build their shipped constants from this module.
//
// Zero runtime deps — pure string assembly.

/** Inputs that differ per client; the prose body is shared. */
export interface RuleContentOpts {
  /**
   * The client-specific YAML frontmatter block, WITHOUT a trailing newline
   * (e.g. `---\nname: gocode-notify\ndescription: …\n---`).
   */
  frontmatter: string;
  /**
   * Human description of the runtime hook(s) that own the automatic pings, as it
   * appears inside the "(… )" in the double-notify warning — e.g.
   * `` "Cursor `stop`" `` or `` "Claude Code `Stop` + …" ``.
   */
  hookDescription: string;
}

/**
 * Build the §5.5 rule/skill Markdown for one client. The body is byte-identical
 * across clients except for the frontmatter and the named hook mechanism, so the
 * anti-double-ping guidance stays in lockstep.
 */
export function buildRuleContent({ frontmatter, hookDescription }: RuleContentOpts): string {
  return `${frontmatter}

# gocode-notify — on-demand phone notifications

You have a \`gocode_notify\` MCP tool that sends a push notification to the user's
phone via the GoCode app.

## CRITICAL: do NOT double-notify

Automatic "session done", "agent idle / needs input", and "error" notifications
are ALREADY handled by a runtime hook (${hookDescription}). You MUST NOT call
\`gocode_notify\` for those — the user would get two pings. The hook is
deterministic and always fires.

## When to call gocode_notify

ONLY when the user EXPLICITLY asks to be pinged about a specific thing mid-task,
e.g. "let me know when the build passes", "ping my phone when the migration is
done". Then call it once, at that moment, with a clear \`title\`/\`body\`.

## If it fails

If \`gocode_notify_status\` reports no credentials, tell the user to run
\`npx @gocode/notify login\` and pair from the GoCode app's "Connect a coding
agent" screen. Do not retry more than twice.
`;
}

/**
 * Claude Code SKILL.md frontmatter (PRD §5.5). The `description` is trigger-y so
 * the skill surfaces on "text me / ping me / notify me when …".
 */
export const CLAUDE_FRONTMATTER = `---
name: gocode-notify
description: On-demand phone notifications via the GoCode app. Use ONLY when the user EXPLICITLY asks to be pinged/notified when something finishes (e.g. "text me when the build is done").
---`;

/** How Claude Code's automatic-ping hooks are named in the double-notify warning. */
export const CLAUDE_HOOK_DESCRIPTION = "Claude Code `Stop` + `Notification` +\n`SubagentStop`";

/**
 * Cursor rule frontmatter (PRD §5.5). `alwaysApply: false` + a trigger-y
 * description so Cursor surfaces it on "notify me / ping me / let me know when".
 */
export const CURSOR_FRONTMATTER = `---
description: On-demand phone notifications via the GoCode app. Use ONLY when the user EXPLICITLY asks to be pinged/notified when something finishes (e.g. "notify me when the build is done", "ping me", "let me know when").
alwaysApply: false
---`;

/** How Cursor's automatic-ping hook is named in the double-notify warning. */
export const CURSOR_HOOK_DESCRIPTION = "Cursor `stop`";
