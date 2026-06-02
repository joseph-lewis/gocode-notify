// Tests for the shared rule/skill content (PRD §5.5 — anti-double-ping). The
// content is the single source of truth shipped into BOTH clients; these tests
// pin the invariants that make the feature correct:
//   • The double-notify warning is present and names the owning hook.
//   • The on-demand-only guidance is present (call only when user EXPLICITLY asks).
//   • The failure/login guidance is present.
//   • Each client's shipped constant (SKILL_CONTENT / RULE_CONTENT) is exactly
//     the builder's output framed with that client's frontmatter — so the two
//     clients cannot silently drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRuleContent,
  CLAUDE_FRONTMATTER,
  CLAUDE_HOOK_DESCRIPTION,
  CURSOR_FRONTMATTER,
  CURSOR_HOOK_DESCRIPTION,
} from "../src/rule-content.js";
import { SKILL_CONTENT } from "../src/claude.js";
import { RULE_CONTENT } from "../src/cursor.js";

/** Invariants every client's §5.5 content must satisfy. */
function assertSection55Invariants(content: string, hookMention: RegExp): void {
  // The headline anti-double-ping rule.
  assert.match(content, /do NOT double-notify/i);
  // It must name the runtime hook that owns the automatic pings.
  assert.match(content, hookMention);
  // The on-demand-only contract.
  assert.match(content, /ONLY when the user EXPLICITLY asks/);
  assert.match(content, /## When to call gocode_notify/);
  // Mentions the MCP tool the agent actually calls.
  assert.match(content, /gocode_notify/);
  // Failure/login guidance (with a retry cap so the agent doesn't spam).
  assert.match(content, /gocode_notify_status/);
  assert.match(content, /npx @trygocode\/notify login/);
  assert.match(content, /Do not retry more than twice/);
}

test("Claude skill content satisfies all §5.5 invariants and names its hooks", () => {
  assertSection55Invariants(SKILL_CONTENT, /Claude Code `Stop`/);
  // Claude SKILL.md frontmatter: name + trigger-y description.
  assert.match(SKILL_CONTENT, /^---\nname: gocode-notify\n/);
  assert.match(SKILL_CONTENT, /Notification/);
  assert.match(SKILL_CONTENT, /SubagentStop/);
});

test("Cursor rule content satisfies all §5.5 invariants and names its hook", () => {
  assertSection55Invariants(RULE_CONTENT, /Cursor `stop`/);
  // Cursor rule frontmatter: alwaysApply false so it triggers on intent only.
  assert.match(RULE_CONTENT, /^---\n/);
  assert.match(RULE_CONTENT, /alwaysApply: false/);
});

test("both clients ship the IDENTICAL body — only frontmatter + named hook differ", () => {
  // Strip each client's frontmatter and its named hook mention; what remains
  // (the actual guidance prose) must be byte-identical across the two clients.
  const stripFrontmatter = (s: string): string => s.replace(/^---\n[\s\S]*?\n---\n/, "");
  const claudeBody = stripFrontmatter(SKILL_CONTENT).replace(CLAUDE_HOOK_DESCRIPTION, "<HOOK>");
  const cursorBody = stripFrontmatter(RULE_CONTENT).replace(CURSOR_HOOK_DESCRIPTION, "<HOOK>");
  assert.equal(claudeBody, cursorBody);
});

test("the shipped constants are exactly the builder output (single source of truth)", () => {
  assert.equal(
    SKILL_CONTENT,
    buildRuleContent({ frontmatter: CLAUDE_FRONTMATTER, hookDescription: CLAUDE_HOOK_DESCRIPTION }),
  );
  assert.equal(
    RULE_CONTENT,
    buildRuleContent({ frontmatter: CURSOR_FRONTMATTER, hookDescription: CURSOR_HOOK_DESCRIPTION }),
  );
});

test("buildRuleContent interpolates the given frontmatter and hook description", () => {
  const out = buildRuleContent({ frontmatter: "---\nfoo: bar\n---", hookDescription: "MyRuntime `done`" });
  assert.match(out, /^---\nfoo: bar\n---\n\n# gocode-notify/);
  assert.match(out, /runtime hook \(MyRuntime `done`\)/);
  // The fixed guidance sections are always present regardless of inputs.
  assert.match(out, /do NOT double-notify/i);
  assert.match(out, /Do not retry more than twice/);
});
