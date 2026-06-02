// gocode-notify `uninstall` — remove EXACTLY the entries this tool added (PRD
// §4.1, §11). The inverse of `setup`'s config-write step.
//
// It runs each runtime's surgical uninstaller (Claude Code / Cursor), each of
// which removes ONLY our hook entries, our MCP server entry, and our rule/skill
// file — never the user's own hooks/servers/keys, and never the shared
// `skills/` or `rules/` trees (PRD §11: "uninstall is clean", no collateral).
//
// Scope notes:
//   - Runs UNCONDITIONALLY against every known runtime (NOT gated on detection):
//     the per-runtime uninstallers are clean no-ops when nothing of ours is
//     present, so we still clean up after a runtime whose config dir was already
//     removed, and we never depend on detection succeeding to undo a prior
//     install. Idempotent — a second run reports "no entries found" per runtime.
//   - Does NOT touch credentials (`~/.gocode/`). Pairing is independent of client
//     wiring (a user who removes the hooks may still `login` again later), so
//     uninstall leaves the API key in place. The PRD scopes this command to the
//     hooks/MCP/rule entries only.
//
// Every step is reported as a {@link StepLine}, so the CLI layer can render the
// result either as a human summary or as one JSON line per step in
// `--agent-driven` mode (PRD §4.4) without re-deriving anything.
//
// Zero runtime deps — Node built-ins only, matching the package's zero-dep rule.
import type { PathOpts } from "./creds.js";
import {
  uninstallClaudeConfig,
  CLAUDE_RUNTIME_NAME,
  type UninstallResult,
} from "./claude.js";
import { uninstallCursorConfig, CURSOR_RUNTIME_NAME } from "./cursor.js";
import type { StepLine } from "./agent.js";

/** Removes one runtime's gocode-notify entries. Must never throw. */
export type RuntimeUninstaller = (opts?: PathOpts) => Promise<UninstallResult>;

/** One runtime's uninstall result, tagged with the runtime name. */
export interface UninstallOutcome extends UninstallResult {
  /** Runtime display name, e.g. "Claude Code". */
  runtime: string;
}

/** The full result of an {@link uninstall} run. Never thrown — always returned. */
export interface UninstallSummary {
  /** True when NO runtime uninstaller hard-failed. */
  ok: boolean;
  /** Per-runtime outcomes, in run order. */
  runtimes: UninstallOutcome[];
  /** Every absolute path removed/modified across all runtimes. */
  removed: string[];
  /** Ordered step lines for rendering (human summary or `--agent-driven` JSON). */
  steps: StepLine[];
}

/** Inputs to {@link uninstall}. */
export interface UninstallOptions extends PathOpts {
  /**
   * Injectable per-runtime uninstallers (defaults to Claude Code + Cursor). Lets
   * tests stub the runtime layer; production uses {@link defaultUninstallers}.
   */
  uninstallers?: ReadonlyArray<{ runtime: string; run: RuntimeUninstaller }>;
}

/** The production runtime uninstallers, in run order. */
export const defaultUninstallers: ReadonlyArray<{
  runtime: string;
  run: RuntimeUninstaller;
}> = [
  { runtime: CLAUDE_RUNTIME_NAME, run: uninstallClaudeConfig },
  { runtime: CURSOR_RUNTIME_NAME, run: uninstallCursorConfig },
];

/**
 * Run the uninstall orchestration (PRD §4.1, §11). Resolves (never rejects) to a
 * {@link UninstallSummary}. Removes exactly our entries from every known runtime,
 * preserving the user's own config. Idempotent.
 */
export async function uninstall(opts: UninstallOptions = {}): Promise<UninstallSummary> {
  const pathOpts: PathOpts = { home: opts.home };
  const runners = opts.uninstallers ?? defaultUninstallers;

  const runtimes: UninstallOutcome[] = [];
  const removed: string[] = [];
  const steps: StepLine[] = [];

  for (const { runtime, run } of runners) {
    const result = await run(pathOpts);
    const outcome: UninstallOutcome = { runtime, ...result };
    runtimes.push(outcome);
    removed.push(...result.removed);
    steps.push({
      step: `uninstall:${runtime}`,
      ok: !result.failed,
      detail: result.detail,
    });
  }

  const ok = runtimes.every((r) => !r.failed);
  steps.push({
    step: "summary",
    ok,
    detail:
      removed.length > 0
        ? `removed ${removed.length} gocode-notify entr${removed.length === 1 ? "y" : "ies"}`
        : "no gocode-notify entries found",
  });

  return { ok, runtimes, removed, steps };
}
