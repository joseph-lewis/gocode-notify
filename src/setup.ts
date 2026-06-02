// gocode-notify `setup` — the one-line installer orchestration (PRD §5).
//
// Drives the documented install sequence end-to-end:
//   1. Pair        — exchange a 6-digit code for an API key (skip if already
//                    paired; `--force` re-pairs). Reuses the `login` flow.
//   2. Detect      — probe well-known config dirs for installed agent runtimes
//                    (Claude Code / Cursor / OpenCode). Reuses `detectRuntimes`.
//   3. Write configs — for each DETECTED runtime, write its hooks/rule/MCP entry.
//   4. Summary     — report exactly what was paired / detected / written.
//
// This module owns the ORCHESTRATION and its idempotency contract. The actual
// per-runtime config writers (Claude Code / Cursor) are dedicated follow-up
// tracker tasks; `setup` consumes them through the {@link RuntimeConfigWriter}
// seam. Until those land, the default writer reports each detected runtime as
// "pending" (nothing written, no failure) so the orchestration is complete,
// honest, and testable now, and the writers drop in without touching this file.
//
// Every step is reported as a {@link StepLine}, so the CLI layer can render the
// same result either as a human summary or as one JSON line per step in
// `--agent-driven` mode (PRD §2 Path 2, §4.4) without re-deriving anything.
//
// Zero runtime deps — Node built-ins only, matching the package's zero-dep rule.
import { login, type LoginOptions, type LoginResult } from "./login.js";
import { readCredentials, type Credentials, type PathOpts } from "./creds.js";
import { detectRuntimes, type RuntimeStatus } from "./status.js";
import { writeClaudeConfig, CLAUDE_RUNTIME_NAME } from "./claude.js";
import { writeCursorConfig, CURSOR_RUNTIME_NAME } from "./cursor.js";
import type { StepLine } from "./agent.js";

/** Outcome of writing one runtime's configuration (hooks / rule / MCP entry). */
export interface ConfigWriteResult {
  /** Runtime display name, e.g. "Claude Code". */
  runtime: string;
  /** Absolute paths actually written or merged (empty when skipped). */
  written: string[];
  /** True when nothing was written (writer pending, or a non-fatal skip). */
  skipped: boolean;
  /** True when the writer failed outright (a real error, not a skip). */
  failed?: boolean;
  /** Human-readable outcome detail. */
  detail: string;
}

/**
 * Writes one DETECTED runtime's configuration. The dedicated config-writer
 * tasks supply the real implementations; `setup` only orchestrates them. A
 * writer must be idempotent (safe to re-run) and must never throw — it returns
 * a {@link ConfigWriteResult} describing what it did.
 */
export type RuntimeConfigWriter = (
  runtime: RuntimeStatus,
  opts: PathOpts,
) => Promise<ConfigWriteResult>;

/**
 * Default config writer: reports the detected runtime as pending. Replaced by
 * the Claude Code / Cursor config-writer tasks (which register real writers via
 * {@link SetupOptions.writeConfig}). Writing nothing is fully idempotent.
 */
export const pendingConfigWriter: RuntimeConfigWriter = async (runtime) => ({
  runtime: runtime.name,
  written: [],
  skipped: true,
  detail: "config writer not yet implemented",
});

/**
 * The default config writer used in production: routes each detected runtime to
 * its dedicated writer. Claude Code is wired to {@link writeClaudeConfig} and
 * Cursor to {@link writeCursorConfig}; runtimes whose writer has not landed yet
 * (OpenCode) fall through to {@link pendingConfigWriter} (a no-op, fully
 * idempotent).
 */
export const defaultConfigWriter: RuntimeConfigWriter = async (runtime, opts) => {
  if (runtime.name === CLAUDE_RUNTIME_NAME) return writeClaudeConfig(runtime, opts);
  if (runtime.name === CURSOR_RUNTIME_NAME) return writeCursorConfig(runtime, opts);
  return pendingConfigWriter(runtime, opts);
};

/** Inputs to {@link setup}. */
export interface SetupOptions extends PathOpts {
  /** `--pair-code`: 6-digit code for non-interactive pairing. */
  pairCode?: string;
  /** `--label`: human label for this machine (defaults to the hostname). */
  label?: string;
  /** `--server`: server URL override (else GOCODE_SERVER / creds / default). */
  server?: string;
  /** `--force`: re-pair even when credentials already exist. */
  force?: boolean;
  /** Injectable fetch (passed through to the pair step). */
  fetchImpl?: typeof fetch;
  /** Timeout override in ms (passed through to the pair step). */
  timeoutMs?: number;
  /** Injectable interactive code prompt (passed through to the pair step). */
  promptCode?: () => Promise<string>;
  /** Injectable pair step (defaults to {@link login}). Lets tests stub it. */
  pairImpl?: (opts: LoginOptions) => Promise<LoginResult>;
  /** Injectable runtime detector (defaults to {@link detectRuntimes}). */
  detectImpl?: (opts?: PathOpts) => Promise<RuntimeStatus[]>;
  /** Injectable per-runtime config writer (defaults to {@link defaultConfigWriter}). */
  writeConfig?: RuntimeConfigWriter;
}

/** Pairing portion of a {@link SetupResult}. */
export interface PairOutcome {
  /** True when paired (freshly or already). */
  ok: boolean;
  /** True when pairing was skipped because valid credentials already existed. */
  skipped: boolean;
  /** The credentials in effect after this step, when available. */
  credentials?: Credentials;
  /** Human-readable detail. */
  detail: string;
}

/** The full result of a {@link setup} run. Never thrown — always returned. */
export interface SetupResult {
  /** True when pairing succeeded-or-skipped AND no config writer hard-failed. */
  ok: boolean;
  /** Pairing step outcome. */
  pair: PairOutcome;
  /** Every runtime probed (detected and not). */
  detected: RuntimeStatus[];
  /** Config-write results for the DETECTED runtimes (in detection order). */
  configs: ConfigWriteResult[];
  /** Ordered step lines for rendering (human summary or `--agent-driven` JSON). */
  steps: StepLine[];
}

/**
 * Run the installer orchestration (PRD §5). Resolves (never rejects) to a
 * {@link SetupResult}. Idempotent: a second run with credentials already present
 * skips pairing (unless `--force`), and the config writers are themselves
 * idempotent, so re-running converges without clobbering.
 */
export async function setup(opts: SetupOptions = {}): Promise<SetupResult> {
  const pathOpts: PathOpts = { home: opts.home };
  const steps: StepLine[] = [];

  // ── Step 1: pair (skip when already paired and not forced) ────────────────
  const pair = await runPairStep(opts, pathOpts);
  steps.push({
    step: pair.skipped ? "pair (skipped)" : "pair",
    ok: pair.ok,
    detail: pair.detail,
  });

  // ── Step 2: detect installed runtimes ─────────────────────────────────────
  const detect = opts.detectImpl ?? detectRuntimes;
  const detected = await detect(pathOpts);
  const detectedNames = detected.filter((r) => r.detected).map((r) => r.name);
  steps.push({
    step: "detect",
    ok: true,
    detail:
      detectedNames.length > 0
        ? `detected: ${detectedNames.join(", ")}`
        : "no agent runtimes detected",
  });

  // ── Step 3: write configs for each DETECTED runtime ───────────────────────
  // Undetected runtimes are skipped silently (PRD §5.2) — only what's installed
  // gets configured.
  const writeConfig = opts.writeConfig ?? defaultConfigWriter;
  const configs: ConfigWriteResult[] = [];
  for (const runtime of detected.filter((r) => r.detected)) {
    const result = await writeConfig(runtime, pathOpts);
    configs.push(result);
    steps.push({
      step: `config:${result.runtime}`,
      ok: !result.failed,
      detail: result.detail,
    });
  }

  // ── Step 4: summary ───────────────────────────────────────────────────────
  const writtenCount = configs.filter((c) => c.written.length > 0).length;
  const hardFail = configs.some((c) => c.failed);
  const ok = pair.ok && !hardFail;
  steps.push({
    step: "summary",
    ok,
    detail:
      `${pair.skipped ? "already paired" : pair.ok ? "paired" : "not paired"}; ` +
      `${detectedNames.length} runtime(s) detected; ${writtenCount} config(s) written`,
  });

  return { ok, pair, detected, configs, steps };
}

/**
 * The pairing sub-step. Reads existing credentials first: if valid creds are
 * present and `--force` was not passed, pairing is SKIPPED (idempotent re-run).
 * Otherwise it runs the `login` flow (code from `--pair-code` or the injected
 * prompt). A malformed creds file is treated as "not paired" so `--force` is
 * not required to recover from corruption.
 */
async function runPairStep(opts: SetupOptions, pathOpts: PathOpts): Promise<PairOutcome> {
  let existing: Credentials | null = null;
  try {
    existing = await readCredentials(pathOpts);
  } catch {
    existing = null; // malformed → re-pair to recover
  }

  if (existing && !opts.force) {
    return {
      ok: true,
      skipped: true,
      credentials: existing,
      detail: `already paired as ${existing.user_id} (${existing.label}) — use --force to re-pair`,
    };
  }

  const pair = opts.pairImpl ?? login;
  const result = await pair({
    code: opts.pairCode,
    label: opts.label,
    server: opts.server,
    home: opts.home,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    promptCode: opts.promptCode,
  });

  if (result.ok && result.credentials) {
    return {
      ok: true,
      skipped: false,
      credentials: result.credentials,
      detail: `paired as ${result.credentials.user_id} (${result.credentials.label})`,
    };
  }
  return { ok: false, skipped: false, detail: result.error ?? "pairing failed" };
}
