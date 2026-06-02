// `gocode-notify push-on-stop` — the dev-machine (P1) auto-push git flow (PRD §2.1).
//
// SCOPE OF THIS MODULE (T-C3): the GIT FLOW itself — steps 2–9 of PRD §2.1 —
// driven entirely through an INJECTED git runner so it is unit-testable with a
// fake `git` and a stubbed `send` (zero real subprocesses, zero network):
//
//   gate-off no-op · not-a-repo no-op · branch resolution + protected-branch
//   guard · clean-tree no-op · compose commit message · commit (-F tempfile) ·
//   fast-forward push (NEVER --force) · non-FF rejection → error notification ·
//   success → ONE `finished` notification. ALL paths resolve and map to exit 0.
//
// What this module deliberately does NOT do (kept out of scope on purpose):
//   • Settings RESOLUTION / 60s cache / network round-trip (PRD §2.1 step 1) —
//     that is `config.ts` (T-C5). `pushOnStop` takes ALREADY-RESOLVED, merged
//     settings as input; when none are supplied it fails SAFE (auto-push OFF).
//   • The `on-stop` dispatcher + Cursor/Claude hook rewire (PRD §2.2) — that is
//     T-C6. This module is the standalone, independently-callable git flow it
//     will delegate to.
//
// Zero runtime deps — Node built-ins only (child_process / fs / os), matching the
// package's zero-dependency rule. Git is invoked via the injectable runner whose
// default shells out with `child_process.spawn`.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  composeCommitMessage,
  parseNumstat,
  type CommitMessageSettings,
  type ComposeCommitMessageInput,
  type ComposeDeps,
  type ComposeResult,
} from "./commit_message.js";
import { appendLog, send, type SendPayload, type SendResult } from "./send.js";
import type { PathOpts } from "./creds.js";

/** Branches we refuse to auto-push to unless `allow_protected` is explicitly on (PRD §0.5). */
export const PROTECTED_BRANCHES = new Set(["main", "master"]);

/** The `auto_push` settings sub-blob (PRD §3.4 + the §2.4 per-repo `branch` override). */
export interface AutoPushSettings {
  /** OFF by default (PRD §0.5 D4). Auto-push runs ONLY when this is exactly true. */
  enabled?: boolean;
  /** Per-repo override branch (PRD §2.4 step 1) — present only on a merged repo blob. */
  branch?: string | null;
  /** Global default branch (PRD §2.4 step 2). null/absent → use the current branch. */
  default_branch?: string | null;
  /** Branch guard: block main/master unless true (PRD §0.5). Default false. */
  allow_protected?: boolean;
  /** Push remote. Default "origin". */
  remote?: string;
  /** Pass `--no-verify` to commit when true (PRD §2.1 step 7). Default false. */
  skip_git_hooks?: boolean;
}

/** The merged Notify settings slice this flow reads (resolution upstream, T-C5). */
export interface ResolvedPushSettings {
  auto_push?: AutoPushSettings;
  commit_message?: CommitMessageSettings;
}

/** Result of one git invocation. The runner NEVER rejects — failures are codes. */
export interface GitResult {
  /** Process exit code (0 = success). A spawn failure maps to a non-zero code. */
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a single `git <args>` invocation in the repo. Injected with a fake in tests. */
export type GitRunner = (args: readonly string[]) => Promise<GitResult>;

/** The `send()` shape this flow depends on (stubbed in tests). */
export type SendFn = (payload: SendPayload) => Promise<SendResult>;

/** The `composeCommitMessage()` shape this flow depends on (stubbed in tests). */
export type ComposeFn = (
  input: ComposeCommitMessageInput,
  deps?: ComposeDeps,
) => Promise<ComposeResult>;

/** Discrete outcomes of {@link pushOnStop} — every one maps to process exit 0. */
export type PushOutcome =
  | "disabled" // auto-push OFF for this repo (gate) — or no settings (fail-safe)
  | "not-a-repo" // not inside a git work tree / git unavailable
  | "protected-branch-skipped" // resolved branch is protected & guard is on
  | "clean-tree" // nothing staged after `git add -A`
  | "commit-failed" // `git commit` returned non-zero (e.g. a pre-commit hook)
  | "push-rejected" // push rejected (non-FF / any failure) → error notification sent
  | "pushed" // success: committed + pushed + ONE finished notification sent
  | "dry-run"; // --dry-run: resolved + reported, no git writes, no send

/** Structured result of the flow. Always resolved; the caller exits 0 regardless. */
export interface PushResult {
  outcome: PushOutcome;
  /** The resolved push branch, when the flow got that far. */
  branch?: string;
  /** Short commit SHA, on a successful push. */
  sha?: string;
  /** The composed commit message, when one was built. */
  message?: string;
  /** Which generator produced the message (`ai` | `deterministic`). */
  generator?: ComposeResult["generator"];
  /** True when a notification was delivered (2xx). */
  notified?: boolean;
  /** Human-readable note (skips, fallbacks, failures) — also written to the log. */
  detail?: string;
}

/** Options for {@link pushOnStop}. All side-effecting deps are injectable for tests. */
export interface PushOnStopOptions extends PathOpts {
  /** ALREADY-RESOLVED + merged Notify settings (T-C5). Absent → auto-push treated OFF. */
  settings?: ResolvedPushSettings;
  /** Agent source string, e.g. `cursor` | `claude_code` | `opencode`. */
  source?: string;
  /** Repo root. Defaults to `process.cwd()`. Passed to the default git runner's cwd. */
  cwd?: string;
  /** Friendly repo label for the notification's `project` field. */
  project?: string;
  /** dedupe_key forwarded to `send` (T-C6 supplies the per-turn key). */
  dedupeKey?: string;
  /** Print what it WOULD do, performing NO git writes and NO send (PRD §2.1 --dry-run). */
  dryRun?: boolean;
  /** Resolved server URL forwarded to the default `send`. */
  server?: string;
  /** Injectable fetch forwarded to the default `send`. */
  fetchImpl?: typeof fetch;
  /** Timeout (ms) forwarded to the default `send`. */
  timeoutMs?: number;
  /** Timestamp source for log lines (defaults to ISO now). */
  timestamp?: () => string;

  // ── injectable dependencies (defaulted to the real implementations) ──
  /** Git runner. Defaults to {@link defaultGitRunner} bound to `cwd`. */
  git?: GitRunner;
  /** Notification sender. Defaults to the real {@link send}. */
  sendImpl?: SendFn;
  /** Commit-message composer. Defaults to {@link composeCommitMessage}. */
  compose?: ComposeFn;
  /** Writes the commit message to a temp file and returns its path (for `commit -F`). */
  writeCommitFile?: (message: string) => Promise<string>;
  /** Removes a temp commit-message file. Best-effort. */
  removeCommitFile?: (file: string) => Promise<void>;
  /** Best-effort logger. Defaults to appending to `~/.gocode/notify.log`. */
  log?: (line: string) => void | Promise<void>;
}

/**
 * Default git runner: spawn `git <args>` in `cwd`, capture stdout/stderr, and
 * resolve with the exit code. NEVER rejects — a spawn error (e.g. git missing)
 * resolves to a non-zero code so the flow can treat it as "not a repo / no git"
 * rather than throwing and risking a non-zero process exit.
 */
export function makeGitRunner(cwd: string): GitRunner {
  return (args) =>
    new Promise<GitResult>((resolve) => {
      const child = spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr || String(err) }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

/** A ready-to-use default runner bound to the current working directory. */
export const defaultGitRunner: GitRunner = makeGitRunner(process.cwd());

/** Default temp-file writer for `git commit -F` (handles multi-line bodies safely). */
async function defaultWriteCommitFile(message: string): Promise<string> {
  // A per-invocation random suffix avoids collisions between concurrent hooks.
  const name = `gocode-notify-commit-${process.pid}-${randomSuffix()}.txt`;
  const file = path.join(os.tmpdir(), name);
  await fs.writeFile(file, message, "utf8");
  return file;
}

async function defaultRemoveCommitFile(file: string): Promise<void> {
  await fs.rm(file, { force: true }).catch(() => {});
}

/** Small dependency-free random hex suffix (avoids importing crypto for this). */
function randomSuffix(): string {
  return Math.trunc(Date.now() % 0xffffff).toString(16) + process.hrtime.bigint().toString(16).slice(-6);
}

/** True when the push branch is one we must not auto-push to without an explicit opt-in. */
export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch.trim());
}

/** Trim a settings string to a usable value, or undefined if empty/absent. */
function cleanBranch(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}

/**
 * Resolve the effective push branch (PRD §2.4):
 *   1. per-repo override `auto_push.branch`, else
 *   2. global `auto_push.default_branch`, else
 *   3. the current checked-out branch.
 * A CONFIGURED branch (1 or 2) that does not exist locally falls back to the
 * current branch (never auto-created) and the fallback is noted in `detail`.
 */
async function resolveBranch(
  git: GitRunner,
  autoPush: AutoPushSettings,
): Promise<{ branch: string; note?: string }> {
  const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const configured = cleanBranch(autoPush.branch) ?? cleanBranch(autoPush.default_branch);
  if (!configured) return { branch: current };
  if (configured === current) return { branch: current };

  const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${configured}`])).code === 0;
  if (exists) return { branch: configured };
  return {
    branch: current,
    note: `configured branch "${configured}" not found locally — used current branch "${current}"`,
  };
}

/** First line of a commit message (the subject), trimmed. */
function subjectOf(message: string): string {
  const first = message.split("\n", 1)[0] ?? "";
  return first.trim();
}

/**
 * Run the dev-machine auto-push flow (PRD §2.1 steps 2–9). Best-effort and total:
 * it NEVER throws and NEVER rejects — every branch returns a {@link PushResult},
 * and the caller maps any result to process exit 0 so a slow/failed push can never
 * block the agent's turn (PRD §0.5 "Never block the agent").
 */
export async function pushOnStop(opts: PushOnStopOptions = {}): Promise<PushResult> {
  const cwd = opts.cwd ?? process.cwd();
  const git = opts.git ?? makeGitRunner(cwd);
  const compose = opts.compose ?? composeCommitMessage;
  const writeCommitFile = opts.writeCommitFile ?? defaultWriteCommitFile;
  const removeCommitFile = opts.removeCommitFile ?? defaultRemoveCommitFile;
  const source = opts.source ?? "unknown";
  const settings = opts.settings ?? {};
  const autoPush = settings.auto_push ?? {};

  const logLine = async (line: string): Promise<void> => {
    try {
      if (opts.log) await opts.log(line);
      else await appendLog(`PUSH: ${line}`, { home: opts.home, timestamp: opts.timestamp });
    } catch {
      // logging must never be the thing that blocks the flow
    }
  };

  const sendImpl: SendFn =
    opts.sendImpl ??
    ((payload) =>
      send(payload, {
        home: opts.home,
        server: opts.server,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        timestamp: opts.timestamp,
      }));

  try {
    // ── Step 2: gate. Fail-safe: anything other than an explicit `true` is OFF. ──
    if (autoPush.enabled !== true) {
      await logLine("auto-push disabled for this repo — no-op");
      return { outcome: "disabled" };
    }

    // ── Step 3: verify git repo. `true\n` on stdout + code 0 means inside a work tree. ──
    const inside = await git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      await logLine("not inside a git work tree (or git unavailable) — no-op");
      return { outcome: "not-a-repo" };
    }

    // ── Step 4: resolve branch + protected-branch guard (BEFORE staging). ──
    const { branch, note: branchNote } = await resolveBranch(git, autoPush);
    if (branchNote) await logLine(branchNote);
    if (isProtectedBranch(branch) && autoPush.allow_protected !== true) {
      await logLine(`skipped: "${branch}" is protected and allow_protected is off`);
      return {
        outcome: "protected-branch-skipped",
        branch,
        detail: branchNote,
      };
    }

    const remote = cleanBranch(autoPush.remote) ?? "origin";

    // ── --dry-run: report the resolved target, perform NO git writes, NO send. ──
    if (opts.dryRun) {
      await logLine(`dry-run: would push to ${remote} ${branch}`);
      return { outcome: "dry-run", branch, detail: branchNote };
    }

    // ── Step 5: stage everything, then check for a clean tree. ──
    await git(["add", "-A"]);
    const numstat = await git(["diff", "--staged", "--numstat"]);
    const files = parseNumstat(numstat.stdout);
    if (files.length === 0) {
      await logLine("clean tree (nothing staged) — no commit, no notification");
      return { outcome: "clean-tree", branch, detail: branchNote };
    }

    // ── Step 6: compose the commit message (AI with deterministic fallback). ──
    const mode = settings.commit_message?.mode ?? "auto";
    let stagedDiff = "";
    let statSummary = "";
    if (mode !== "deterministic") {
      stagedDiff = (await git(["diff", "--staged"])).stdout;
      statSummary = (await git(["diff", "--staged", "--stat"])).stdout;
    }
    const composed = await compose({
      files,
      stagedDiff,
      statSummary,
      branch,
      source,
      settings: settings.commit_message,
    });

    // ── Step 7: commit via `-F <tempfile>` (safe multi-line / quotes). ──
    const commitArgs = ["commit", "-F"];
    const file = await writeCommitFile(composed.message);
    try {
      const args = [...commitArgs, file];
      if (autoPush.skip_git_hooks === true) args.push("--no-verify");
      const committed = await git(args);
      if (committed.code !== 0) {
        await logLine(`git commit failed (code ${committed.code}): ${committed.stderr.trim()}`);
        return {
          outcome: "commit-failed",
          branch,
          message: composed.message,
          generator: composed.generator,
          detail: committed.stderr.trim() || "commit failed",
        };
      }
    } finally {
      await removeCommitFile(file).catch(() => {});
    }

    const sha = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim() || undefined;

    // ── Step 8: fast-forward push. NEVER --force. ──
    const pushed = await git(["push", remote, branch]);
    if (pushed.code !== 0) {
      // Non-FF rejection (or any push failure): notify + exit 0. Never force.
      await logLine(`push rejected (code ${pushed.code}): ${pushed.stderr.trim()}`);
      const errorBody = isNonFastForward(pushed.stderr)
        ? "auto-push rejected (remote moved); pull + retry"
        : `auto-push failed: ${firstLine(pushed.stderr) || "git push error"}`;
      const res = await sendImpl({
        kind: "error",
        title: "GoCode auto-push failed",
        body: errorBody,
        source,
        project: opts.project,
        dedupe_key: opts.dedupeKey,
      });
      return {
        outcome: "push-rejected",
        branch,
        sha,
        message: composed.message,
        generator: composed.generator,
        notified: res.ok,
        detail: errorBody,
      };
    }

    // ── Step 9: success → ONE finished notification carrying the commit summary. ──
    const subject = subjectOf(composed.message);
    const where = sha ? `${branch} @ ${sha}` : branch;
    const res = await sendImpl({
      kind: "finished",
      title: `Auto-pushed to ${branch}`,
      body: `${subject} — ${where}`,
      source,
      project: opts.project,
      dedupe_key: opts.dedupeKey,
    });
    await logLine(`pushed ${files.length} file(s) to ${remote} ${where} (${composed.generator})`);
    return {
      outcome: "pushed",
      branch,
      sha,
      message: composed.message,
      generator: composed.generator,
      notified: res.ok,
      detail: branchNote,
    };
  } catch (err) {
    // Defence in depth: the flow must never throw. Any unexpected error degrades
    // to a logged no-op so the hook's turn is never blocked (PRD §0.5).
    await logLine(`unexpected error — treated as no-op: ${err instanceof Error ? err.message : String(err)}`);
    return { outcome: "disabled", detail: "unexpected error" };
  }
}

/** True when git's push stderr signals a non-fast-forward / rejected push. */
export function isNonFastForward(stderr: string): boolean {
  return /\b(non-fast-forward|rejected|fetch first|tip of your current branch is behind)\b/i.test(stderr);
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
}
