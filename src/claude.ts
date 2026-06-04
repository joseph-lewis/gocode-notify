// Claude Code config writer (PRD §5.3) — the installer's per-runtime writer for
// Claude Code. It does three things, all idempotently and without clobbering the
// user's existing config:
//
//   1. MERGE three fire-and-forget hooks into `~/.claude/settings.json`:
//        Stop          → "finished"        (a turn completed)
//        Notification  → "awaiting_input"  (the agent needs the user)
//        SubagentStop  → "finished"        (a subagent completed)
//      Each hook shells out to `gocode-notify send … || true` so a failed push
//      NEVER blocks the agent's turn (PRD §4.4, §5.3).
//   2. MERGE an `mcpServers` entry pointing at `npx -y @trygocode/notify mcp`.
//   3. WRITE the on-demand skill to `~/.claude/skills/gocode-notify/SKILL.md`
//      (the anti-double-ping rule, PRD §5.5).
//
// MERGE, never clobber: the user's own hooks / MCP servers / top-level settings
// keys are preserved. Re-running converges (idempotent) — our hook groups and
// MCP entry are replaced in place, not duplicated. `uninstallClaudeConfig`
// removes EXACTLY our entries and nothing else (PRD §11, the uninstall test).
//
// Our entries are identified by a stable marker (the command contains both
// `gocode-notify` and `--source claude_code`) so idempotency and uninstall work
// even across version bumps to the exact command string.
//
// Zero runtime deps — Node built-ins only, matching the package's zero-dep rule.
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveHome, type PathOpts } from "./creds.js";
import type { RuntimeStatus } from "./detect.js";
import type { ConfigWriteResult } from "./setup.js";
import {
  buildRuleContent,
  CLAUDE_FRONTMATTER,
  CLAUDE_HOOK_DESCRIPTION,
} from "./rule-content.js";

/** Display name of the runtime this writer handles (matches the detector). */
export const CLAUDE_RUNTIME_NAME = "Claude Code";

/** MCP server key written into `~/.claude/settings.json` `mcpServers`. */
export const MCP_SERVER_NAME = "gocode-notify";

/** The MCP server entry we register (PRD §4.3, §5.4 invocation form). */
export const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "@trygocode/notify", "mcp"],
} as const;

/**
 * The hook command for each Claude Code event (PRD §5.3, verbatim shape). Every
 * command ends in `|| true` so a notification failure can never block the
 * agent's turn, and carries a per-session `--dedupe-key` so overlapping triggers
 * (e.g. Cursor `stop` + Claude `Stop`) coalesce server-side.
 */
export const CLAUDE_HOOK_COMMANDS: Readonly<Record<string, string>> = {
  Stop: 'npx -y @trygocode/notify send --kind finished --source claude_code --dedupe-key "$CLAUDE_SESSION_ID-stop" || true',
  Notification:
    'npx -y @trygocode/notify send --kind awaiting_input --source claude_code --title "Agent needs you" --dedupe-key "$CLAUDE_SESSION_ID-notify" || true',
  SubagentStop:
    'npx -y @trygocode/notify send --kind finished --source claude_code --title "Subagent done" --dedupe-key "$CLAUDE_SESSION_ID-subagent" || true',
};

/**
 * Substrings that together identify a hook command as OURS. Used for idempotent
 * merge (replace, don't duplicate) and for surgical uninstall (remove exactly
 * ours). A command must contain BOTH to be considered ours.
 *
 * `notify send` matches BOTH the current `npx -y @trygocode/notify send …`
 * form AND the legacy bare `gocode-notify send …` form, so upgrading from an
 * older install is detected and cleanly replaced rather than duplicated.
 */
const HOOK_MARKERS = ["notify send", "--source claude_code"] as const;

/**
 * The on-demand skill written to `~/.claude/skills/gocode-notify/SKILL.md`
 * (PRD §5.5). The crucial content is the anti-double-ping rule: the automatic
 * pings are owned by the runtime hooks, so the agent must only call the MCP tool
 * when the user EXPLICITLY asks. Built from the shared {@link buildRuleContent}
 * so the body stays in lockstep with the Cursor rule.
 */
export const SKILL_CONTENT = buildRuleContent({
  frontmatter: CLAUDE_FRONTMATTER,
  hookDescription: CLAUDE_HOOK_DESCRIPTION,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `~/.claude/` directory for the given (optional) HOME override. */
function claudeDir(opts?: PathOpts): string {
  return path.join(resolveHome(opts), ".claude");
}

/** Absolute path to Claude Code's `settings.json`. */
export function claudeSettingsPath(opts?: PathOpts): string {
  return path.join(claudeDir(opts), "settings.json");
}

/** Absolute path to the directory holding our skill. */
export function claudeSkillDir(opts?: PathOpts): string {
  return path.join(claudeDir(opts), "skills", "gocode-notify");
}

/** Absolute path to our `SKILL.md`. */
export function claudeSkillPath(opts?: PathOpts): string {
  return path.join(claudeSkillDir(opts), "SKILL.md");
}

/**
 * Read a JSON object from `file`. Returns null when the file does not exist.
 * Throws when it exists but is not a JSON object — so we never silently clobber
 * a file we failed to parse (the caller surfaces it as a write failure).
 */
async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`gocode-notify: ${file} contains invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`gocode-notify: ${file} is not a JSON object`);
  }
  return parsed;
}

/** Write a JSON object with 2-space indent + trailing newline (matches creds). */
async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

/** True when a single hook ENTRY (`{ type, command }`) is one we wrote. */
function isOurHookCommand(h: unknown): boolean {
  return (
    isRecord(h) &&
    typeof h.command === "string" &&
    HOOK_MARKERS.every((m) => (h.command as string).includes(m))
  );
}

/**
 * Strip OUR hook entries out of an event's group array, operating at the
 * individual-command level (NOT the whole group): a user group that happens to
 * also contain one of our commands keeps its other commands. Any group left with
 * no commands is dropped. Returns the cleaned array plus whether anything of ours
 * was removed (so callers can detect a real change). Never mutates the input.
 */
function stripOurHooks(groups: unknown[]): { groups: unknown[]; removed: boolean } {
  let removed = false;
  const out: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      out.push(group); // unexpected shape → leave the user's data untouched
      continue;
    }
    const kept = group.hooks.filter((h) => !isOurHookCommand(h));
    if (kept.length !== group.hooks.length) removed = true;
    if (kept.length === 0) continue; // group held only our command(s) → drop it
    out.push(kept.length === group.hooks.length ? group : { ...group, hooks: kept });
  }
  return { groups: out, removed };
}

/** Build the matcher group we add for a single event. */
function ourHookGroup(command: string): Record<string, unknown> {
  return { hooks: [{ type: "command", command }] };
}

/**
 * Merge our three hook events into `settings.hooks`, preserving the user's own
 * hooks. For each event we strip any prior copy of OUR command (idempotent /
 * version-safe) — at the command level, so a user command sharing a group with
 * ours survives — then append a single fresh group. Mutates `settings` in place.
 */
function mergeHooks(settings: Record<string, unknown>): void {
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  for (const [event, command] of Object.entries(CLAUDE_HOOK_COMMANDS)) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const preserved = stripOurHooks(existing).groups;
    preserved.push(ourHookGroup(command));
    hooks[event] = preserved;
  }
  settings.hooks = hooks;
}

/** Merge our MCP server entry into `settings.mcpServers`. Mutates in place. */
function mergeMcp(settings: Record<string, unknown>): void {
  const servers = isRecord(settings.mcpServers) ? settings.mcpServers : {};
  servers[MCP_SERVER_NAME] = { ...MCP_SERVER_ENTRY, args: [...MCP_SERVER_ENTRY.args] };
  settings.mcpServers = servers;
}

/**
 * Install Claude Code config (PRD §5.3): merge hooks + MCP entry into
 * `settings.json` and write the skill. A {@link RuntimeConfigWriter} — never
 * throws; returns a {@link ConfigWriteResult}. Idempotent: re-running converges
 * without duplicating our entries.
 */
export async function writeClaudeConfig(
  runtime?: RuntimeStatus,
  opts?: PathOpts,
): Promise<ConfigWriteResult> {
  const name = runtime?.name ?? CLAUDE_RUNTIME_NAME;
  // Track paths as they land so a mid-way failure (e.g. settings written but the
  // skill write fails) reports what WAS actually written rather than claiming
  // nothing changed.
  const written: string[] = [];
  try {
    await fs.mkdir(claudeDir(opts), { recursive: true });

    const settingsPath = claudeSettingsPath(opts);
    const settings = (await readJsonObject(settingsPath)) ?? {};
    mergeHooks(settings);
    mergeMcp(settings);
    await writeJsonFile(settingsPath, settings);
    written.push(settingsPath);

    const skillPath = claudeSkillPath(opts);
    await fs.mkdir(claudeSkillDir(opts), { recursive: true });
    await fs.writeFile(skillPath, SKILL_CONTENT);
    written.push(skillPath);

    return {
      runtime: name,
      written,
      skipped: false,
      detail: "merged Stop/Notification/SubagentStop hooks + MCP entry; wrote skill",
    };
  } catch (err) {
    return {
      runtime: name,
      written,
      skipped: false,
      failed: true,
      detail: `Claude Code config write failed: ${errMessage(err)}`,
    };
  }
}

/** What a per-runtime uninstaller removed. */
export interface UninstallResult {
  /** Absolute paths we modified or removed. */
  removed: string[];
  /** True when the uninstall errored out (a real IO/permission error, not a no-op). */
  failed?: boolean;
  /** Human-readable outcome detail. */
  detail: string;
}

/**
 * Remove EXACTLY the entries this writer added (PRD §11): our three hook groups,
 * our MCP server entry, and our skill directory. The user's own hooks, MCP
 * servers, and other settings keys are preserved untouched. Idempotent — a
 * second run (or a run when nothing was installed) is a clean no-op. Never
 * throws.
 */
export async function uninstallClaudeConfig(opts?: PathOpts): Promise<UninstallResult> {
  const removed: string[] = [];
  try {
    const settingsPath = claudeSettingsPath(opts);
    const settings = await readJsonObject(settingsPath);
    if (settings) {
      let changed = false;

      if (isRecord(settings.hooks)) {
        const hooks = settings.hooks;
        for (const event of Object.keys(CLAUDE_HOOK_COMMANDS)) {
          if (!Array.isArray(hooks[event])) continue;
          const { groups: kept, removed } = stripOurHooks(hooks[event] as unknown[]);
          if (removed) changed = true;
          if (kept.length > 0) hooks[event] = kept;
          else delete hooks[event];
        }
        if (Object.keys(hooks).length === 0) delete settings.hooks;
      }

      if (isRecord(settings.mcpServers) && MCP_SERVER_NAME in settings.mcpServers) {
        delete settings.mcpServers[MCP_SERVER_NAME];
        changed = true;
        if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
      }

      if (changed) {
        await writeJsonFile(settingsPath, settings);
        removed.push(settingsPath);
      }
    }

    // Remove only OUR skill dir, never the whole `skills/` tree. Stat first so
    // we report it in `removed` only when it actually existed.
    const skillDir = claudeSkillDir(opts);
    let skillExisted = false;
    try {
      await fs.stat(skillDir);
      skillExisted = true;
    } catch (err) {
      // Only ENOENT means "not installed". A permission/IO error must surface as
      // a failure, not be silently reported as a clean uninstall.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      skillExisted = false;
    }
    if (skillExisted) {
      await fs.rm(skillDir, { recursive: true, force: true });
      removed.push(skillDir);
    }

    return {
      removed,
      detail:
        removed.length > 0
          ? `removed gocode-notify entries (${removed.length} path${removed.length === 1 ? "" : "s"})`
          : "no gocode-notify entries found",
    };
  } catch (err) {
    return { removed, failed: true, detail: `Claude Code uninstall failed: ${errMessage(err)}` };
  }
}
