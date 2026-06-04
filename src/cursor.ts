// Cursor config writer (PRD §5.4, §5.5) — the installer's per-runtime writer for
// Cursor. It does three things, all idempotently and without clobbering the
// user's existing config:
//
//   1. MERGE a fire-and-forget `stop` hook into `~/.cursor/hooks.json`:
//        stop → "finished" (the agent completed a turn).
//      The command shells out to `gocode-notify send … || true` so a failed push
//      NEVER blocks the agent's turn (PRD §4.4, §5.4). The file's `version` is
//      preserved (or set to 1 when creating it fresh).
//   2. MERGE an `mcpServers` entry into `~/.cursor/mcp.json` pointing at
//      `npx -y @trygocode/notify mcp`.
//   3. WRITE the on-demand rule to `~/.cursor/rules/gocode-notify.md` (the
//      anti-double-ping rule, PRD §5.5, `alwaysApply: false`).
//
// MERGE, never clobber: the user's own hooks / MCP servers / top-level keys are
// preserved. Re-running converges (idempotent) — our stop entry and MCP entry
// are replaced in place, not duplicated. `uninstallCursorConfig` removes EXACTLY
// our entries and nothing else (PRD §11, the uninstall test).
//
// Our entries are identified by a stable marker (the command contains both
// `gocode-notify` and `--source cursor`) so idempotency and uninstall work even
// across version bumps to the exact command string.
//
// Zero runtime deps — Node built-ins only, matching the package's zero-dep rule.
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveHome, type PathOpts } from "./creds.js";
import type { RuntimeStatus } from "./detect.js";
import type { ConfigWriteResult } from "./setup.js";
import type { UninstallResult } from "./claude.js";
import {
  buildRuleContent,
  CURSOR_FRONTMATTER,
  CURSOR_HOOK_DESCRIPTION,
} from "./rule-content.js";

/** Display name of the runtime this writer handles (matches the detector). */
export const CURSOR_RUNTIME_NAME = "Cursor";

/** MCP server key written into `~/.cursor/mcp.json` `mcpServers`. */
export const MCP_SERVER_NAME = "gocode-notify";

/** The MCP server entry we register (PRD §4.3, §5.4 invocation form). */
export const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "@trygocode/notify", "mcp"],
} as const;

/**
 * The Cursor `stop` hook command (PRD §5.4, verbatim shape). Ends in `|| true`
 * so a notification failure can never block the agent's turn, and carries a
 * `--dedupe-key` so overlapping triggers (e.g. Cursor `stop` + Claude `Stop`)
 * coalesce server-side.
 */
export const CURSOR_STOP_COMMAND =
  "npx -y @trygocode/notify send --kind finished --source cursor --dedupe-key cursor-stop || true";

/**
 * Substrings that together identify a `stop` hook entry as OURS. Used for
 * idempotent merge (replace, don't duplicate) and for surgical uninstall (remove
 * exactly ours). A command must contain BOTH to be considered ours.
 *
 * `notify send` matches BOTH the current `npx -y @trygocode/notify send …`
 * form AND the legacy bare `gocode-notify send …` form, so an upgrade from an
 * older install is detected and cleanly replaced rather than duplicated.
 */
const HOOK_MARKERS = ["notify send", "--source cursor"] as const;

/**
 * The on-demand rule written to `~/.cursor/rules/gocode-notify.md` (PRD §5.5).
 * The crucial content is the anti-double-ping rule: the automatic pings are
 * owned by the Cursor `stop` hook, so the agent must only call the MCP tool when
 * the user EXPLICITLY asks. `alwaysApply: false` + a trigger-y description so
 * Cursor surfaces it on "notify me / ping me / let me know when". Built from the
 * shared {@link buildRuleContent} so the body stays in lockstep with the Claude
 * Code skill.
 */
export const RULE_CONTENT = buildRuleContent({
  frontmatter: CURSOR_FRONTMATTER,
  hookDescription: CURSOR_HOOK_DESCRIPTION,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `~/.cursor/` directory for the given (optional) HOME override. */
function cursorDir(opts?: PathOpts): string {
  return path.join(resolveHome(opts), ".cursor");
}

/** Absolute path to Cursor's `hooks.json`. */
export function cursorHooksPath(opts?: PathOpts): string {
  return path.join(cursorDir(opts), "hooks.json");
}

/** Absolute path to Cursor's `mcp.json`. */
export function cursorMcpPath(opts?: PathOpts): string {
  return path.join(cursorDir(opts), "mcp.json");
}

/** Absolute path to the directory holding Cursor rules. */
export function cursorRulesDir(opts?: PathOpts): string {
  return path.join(cursorDir(opts), "rules");
}

/** Absolute path to our rule file. */
export function cursorRulePath(opts?: PathOpts): string {
  return path.join(cursorRulesDir(opts), "gocode-notify.md");
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

/** True when a single `stop` hook entry (`{ command }`) is one we wrote. */
function isOurStopHook(h: unknown): boolean {
  return (
    isRecord(h) &&
    typeof h.command === "string" &&
    HOOK_MARKERS.every((m) => (h.command as string).includes(m))
  );
}

/**
 * Strip OUR entries out of the `stop` array. Returns the cleaned array plus
 * whether anything of ours was removed (so callers can detect a real change).
 * Never mutates the input.
 */
function stripOurStopHooks(entries: unknown[]): { entries: unknown[]; removed: boolean } {
  const kept = entries.filter((h) => !isOurStopHook(h));
  return { entries: kept, removed: kept.length !== entries.length };
}

/**
 * Merge our `stop` hook into the hooks config, preserving the user's own stop
 * entries and `version`. Strips any prior copy of OUR command (idempotent /
 * version-safe) then appends a single fresh entry. Mutates `config` in place.
 * A fresh file gets `version: 1` (PRD §5.4); an existing `version` is preserved.
 */
function mergeStopHook(config: Record<string, unknown>): void {
  if (typeof config.version !== "number") config.version = 1;
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  const existing = Array.isArray(hooks.stop) ? (hooks.stop as unknown[]) : [];
  const preserved = stripOurStopHooks(existing).entries;
  preserved.push({ command: CURSOR_STOP_COMMAND });
  hooks.stop = preserved;
  config.hooks = hooks;
}

/** Merge our MCP server entry into `mcp.mcpServers`. Mutates in place. */
function mergeMcp(mcp: Record<string, unknown>): void {
  const servers = isRecord(mcp.mcpServers) ? mcp.mcpServers : {};
  servers[MCP_SERVER_NAME] = { ...MCP_SERVER_ENTRY, args: [...MCP_SERVER_ENTRY.args] };
  mcp.mcpServers = servers;
}

/**
 * Install Cursor config (PRD §5.4): merge the `stop` hook into `hooks.json`,
 * merge the MCP entry into `mcp.json`, and write the rule. A
 * {@link RuntimeConfigWriter} — never throws; returns a {@link ConfigWriteResult}.
 * Idempotent: re-running converges without duplicating our entries.
 */
export async function writeCursorConfig(
  runtime?: RuntimeStatus,
  opts?: PathOpts,
): Promise<ConfigWriteResult> {
  const name = runtime?.name ?? CURSOR_RUNTIME_NAME;
  // Track paths as they land so a mid-way failure reports what WAS actually
  // written rather than claiming nothing changed.
  const written: string[] = [];
  try {
    await fs.mkdir(cursorDir(opts), { recursive: true });

    const hooksPath = cursorHooksPath(opts);
    const hooksConfig = (await readJsonObject(hooksPath)) ?? {};
    mergeStopHook(hooksConfig);
    await writeJsonFile(hooksPath, hooksConfig);
    written.push(hooksPath);

    const mcpPath = cursorMcpPath(opts);
    const mcpConfig = (await readJsonObject(mcpPath)) ?? {};
    mergeMcp(mcpConfig);
    await writeJsonFile(mcpPath, mcpConfig);
    written.push(mcpPath);

    const rulePath = cursorRulePath(opts);
    await fs.mkdir(cursorRulesDir(opts), { recursive: true });
    await fs.writeFile(rulePath, RULE_CONTENT);
    written.push(rulePath);

    return {
      runtime: name,
      written,
      skipped: false,
      detail: "merged stop hook + MCP entry; wrote rule",
    };
  } catch (err) {
    return {
      runtime: name,
      written,
      skipped: false,
      failed: true,
      detail: `Cursor config write failed: ${errMessage(err)}`,
    };
  }
}

/**
 * Remove EXACTLY the entries this writer added (PRD §11): our `stop` hook entry,
 * our MCP server entry, and our rule file. The user's own hooks, MCP servers,
 * `version`, and other keys are preserved untouched. Idempotent — a second run
 * (or a run when nothing was installed) is a clean no-op. Never throws.
 */
export async function uninstallCursorConfig(opts?: PathOpts): Promise<UninstallResult> {
  const removed: string[] = [];
  try {
    // hooks.json — strip our stop entry (command-level, preserving the user's).
    const hooksPath = cursorHooksPath(opts);
    const hooksConfig = await readJsonObject(hooksPath);
    if (hooksConfig && isRecord(hooksConfig.hooks)) {
      const hooks = hooksConfig.hooks;
      let changed = false;
      if (Array.isArray(hooks.stop)) {
        const { entries: kept, removed: r } = stripOurStopHooks(hooks.stop as unknown[]);
        if (r) {
          changed = true;
          if (kept.length > 0) hooks.stop = kept;
          else delete hooks.stop;
        }
      }
      if (Object.keys(hooks).length === 0) delete hooksConfig.hooks;
      if (changed) {
        await writeJsonFile(hooksPath, hooksConfig);
        removed.push(hooksPath);
      }
    }

    // mcp.json — remove our server entry only.
    const mcpPath = cursorMcpPath(opts);
    const mcpConfig = await readJsonObject(mcpPath);
    if (mcpConfig && isRecord(mcpConfig.mcpServers) && MCP_SERVER_NAME in mcpConfig.mcpServers) {
      delete mcpConfig.mcpServers[MCP_SERVER_NAME];
      if (Object.keys(mcpConfig.mcpServers).length === 0) delete mcpConfig.mcpServers;
      await writeJsonFile(mcpPath, mcpConfig);
      removed.push(mcpPath);
    }

    // rules/gocode-notify.md — remove only OUR rule file, never the rules dir.
    const rulePath = cursorRulePath(opts);
    let ruleExisted = false;
    try {
      await fs.stat(rulePath);
      ruleExisted = true;
    } catch (err) {
      // Only ENOENT means "not installed". A permission/IO error must surface as
      // a failure, not be silently reported as a clean uninstall.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      ruleExisted = false;
    }
    if (ruleExisted) {
      await fs.rm(rulePath, { force: true });
      removed.push(rulePath);
    }

    return {
      removed,
      detail:
        removed.length > 0
          ? `removed gocode-notify entries (${removed.length} path${removed.length === 1 ? "" : "s"})`
          : "no gocode-notify entries found",
    };
  } catch (err) {
    return { removed, failed: true, detail: `Cursor uninstall failed: ${errMessage(err)}` };
  }
}
