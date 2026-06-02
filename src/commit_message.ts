// Commit-message composition for `gocode-notify push-on-stop` (PRD §2.3).
//
// SCOPE OF THIS MODULE (T-C1): the DETERMINISTIC fallback only — the structured
// message built purely from the staged diff stat + branch + agent source, plus
// the cheap path-based `<type>` inference. This path has zero dependencies, never
// touches the network, and never shells out, so it is ALWAYS available and is the
// guaranteed fallback the PRD requires ("the push must NEVER block or fail because
// the AI summary was unavailable" — §0.4).
//
// The local-summariser resolution chain + sanitiser + 8s cap that wrap this
// fallback (the full `composeCommitMessage()` entry point — T-C2) are layered on
// top of these pure functions at the bottom of this file: they call
// `buildDeterministicMessage` when the AI path is disabled, fails, or times out.
//
// Zero runtime deps — only Node built-ins (child_process / fs for the local
// summariser subprocess), to match the package's zero-dep rule.
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * The conventional-commit `<type>` prefix inferred from the changed paths.
 * Intentionally a tiny, deterministic set (PRD §2.3) — NOT the full
 * conventional-commits taxonomy. Order of precedence when classifying a changeset
 * is docs → test → chore → feat (see {@link inferCommitType}).
 */
export type CommitType = "docs" | "test" | "chore" | "feat";

/** Per-file line delta, as produced by `git diff --staged --numstat`. */
export interface FileStat {
  /** Repo-relative path (the numstat path field, verbatim). */
  path: string;
  /** Lines added. 0 for binary files (numstat reports `-`). */
  added: number;
  /** Lines deleted. 0 for binary files (numstat reports `-`). */
  deleted: number;
  /** True when git reported `-`/`-` counts (binary blob). */
  binary?: boolean;
}

/** Inputs for the deterministic fallback message. */
export interface DeterministicMessageInput {
  /** Parsed per-file stats for the staged changes (see {@link parseNumstat}). */
  files: FileStat[];
  /** The branch the commit lands on (PRD §2.4 resolution happens upstream). */
  branch: string;
  /** The agent source string, e.g. `cursor` | `claude_code` | `opencode`. */
  source: string;
}

/** Max number of per-file stat lines rendered before collapsing to "...and M more". */
const MAX_STAT_LINES = 10;

const MARKDOWN_RE = /\.(?:md|mdx|markdown)$/i;

// A path counts as "test" if any segment is a conventional test directory, or the
// filename carries a `.test.`/`.spec.` infix (covers TS/JS/Dart/Python conventions).
const TEST_DIR_RE = /(?:^|\/)(?:tests?|__tests__|spec|specs)\//i;
const TEST_FILE_RE = /(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$/i;

// "chore" = config / lockfiles / dotfiles that aren't product code. Kept deliberately
// conservative: a clear lockfile, a known config filename, or a repo dotfile.
const LOCKFILE_RE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pubspec\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock)$/i;
const CONFIG_FILE_RE =
  /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|pubspec\.yaml|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.nvmrc|\.eslintrc(?:\.[^/]+)?|\.prettierrc(?:\.[^/]+)?|[^/]*\.config\.[^/]+)$/i;

function isDocsPath(path: string): boolean {
  return MARKDOWN_RE.test(path);
}

function isTestPath(path: string): boolean {
  return TEST_DIR_RE.test(path) || TEST_FILE_RE.test(path);
}

function isChorePath(path: string): boolean {
  return LOCKFILE_RE.test(path) || CONFIG_FILE_RE.test(path);
}

/**
 * Infer the commit `<type>` from the changed paths (PRD §2.3), deterministically:
 *   • `docs`  — every path is markdown.
 *   • `test`  — every path lives in a test dir or is a `.test.`/`.spec.` file.
 *   • `chore` — every path is a lockfile / known config / repo dotfile.
 *   • `feat`  — anything else (the catch-all; also the empty-changeset default).
 *
 * "Every path" semantics: a mixed changeset (e.g. a `.ts` source file + its test)
 * falls through to `feat`, which is the safe, honest default for a real change.
 */
export function inferCommitType(paths: string[]): CommitType {
  if (paths.length === 0) return "feat";
  if (paths.every(isDocsPath)) return "docs";
  if (paths.every(isTestPath)) return "test";
  if (paths.every(isChorePath)) return "chore";
  return "feat";
}

/**
 * Parse `git diff --staged --numstat` output into {@link FileStat}s. numstat emits
 * one tab-separated `added\tdeleted\tpath` record per file; binary files report
 * `-` for both counts. Blank lines and malformed records are skipped (forgiving —
 * this feeds a best-effort commit message, never a hard gate).
 *
 * Rename records (`old => new`, `dir/{a => b}/file`) are preserved verbatim in
 * `path`; we do not attempt to expand them — the raw git rendering is fine for a
 * commit-body stat line.
 */
export function parseNumstat(numstat: string): FileStat[] {
  const out: FileStat[] = [];
  for (const rawLine of numstat.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const [, addedRaw, deletedRaw, path] = m;
    const binary = addedRaw === "-" || deletedRaw === "-";
    out.push({
      path,
      added: addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10),
      deleted: deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw, 10),
      ...(binary ? { binary: true } : {}),
    });
  }
  return out;
}

/** Render one file's stat line for the commit body: `path | +A -D` (or `| bin`). */
function statLine(f: FileStat): string {
  if (f.binary) return `${f.path} | bin`;
  return `${f.path} | +${f.added} -${f.deleted}`;
}

/**
 * Build the deterministic fallback commit message (PRD §2.3 template):
 *
 *   <type>: <N> file(s) changed on <branch>
 *
 *   <up to 10 "path | +A -D" lines, then "...and M more">
 *
 *   Auto-committed by GoCode Notify (source: <source>).
 *
 * Pure and total: given the same input it always returns the same string, and it
 * never throws on an empty changeset (returns a coherent "0 files" message — the
 * caller is responsible for the clean-tree no-op gate, §2.1 step 5).
 */
export function buildDeterministicMessage({ files, branch, source }: DeterministicMessageInput): string {
  const type = inferCommitType(files.map((f) => f.path));
  const n = files.length;
  const subject = `${type}: ${n} ${n === 1 ? "file" : "files"} changed on ${branch}`;

  const shown = files.slice(0, MAX_STAT_LINES);
  const lines = shown.map(statLine);
  const more = n - shown.length;
  if (more > 0) lines.push(`...and ${more} more`);
  const statBlock = lines.join("\n");

  const footer = `Auto-committed by GoCode Notify (source: ${source}).`;

  // A real changeset always has a stat block; guard the empty case so we never
  // emit a stray blank line that would confuse `git commit -F`.
  return statBlock === ""
    ? `${subject}\n\n${footer}`
    : `${subject}\n\n${statBlock}\n\n${footer}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// T-C2: local-summariser resolution chain + sanitiser + 8s cap + fallback.
//
// `composeCommitMessage()` is the entry point the push flow (§2.1 step 6) calls.
// It tries the "free" local-AI summariser first (when enabled + available), then
// ALWAYS falls back to the deterministic message above. Per PRD §0.4 the push
// must NEVER block or fail because the AI summary was unavailable, so every AI
// failure mode here (disabled, no command, subprocess error, non-zero exit,
// timeout, empty/garbage output) silently degrades to the deterministic path.
// ─────────────────────────────────────────────────────────────────────────────

/** The `commit_message` settings blob (PRD §3.4). All fields optional → defaults. */
export interface CommitMessageSettings {
  /** `"deterministic"` skips AI entirely; `"ai"`/`"auto"` enable the summariser. */
  mode?: "auto" | "ai" | "deterministic";
  /** Explicit summariser command line, e.g. `"claude -p"`. null → auto-detect. */
  command?: string | null;
  /** Byte cap on the diff piped to the summariser (keeps the call cheap). */
  max_diff_bytes?: number;
}

/** Hard cap (ms) on the WHOLE AI attempt, per PRD §2.3 ("8s hard cap total"). */
export const AI_TIMEOUT_MS = 8000;

/** Default diff byte cap (PRD §2.3 / §3.4 `max_diff_bytes`: 60 KB). */
export const DEFAULT_MAX_DIFF_BYTES = 61440;

/** Max subject-line length the sanitiser clamps AI output to (PRD §2.3: ≤ 72). */
export const SUBJECT_MAX = 72;

/** Fixed prompt prefix sent to the local summariser (PRD §2.3). */
export const COMMIT_PROMPT =
  "Write a concise git commit message (imperative subject ≤ 72 chars, optional " +
  "1–3 line body) describing these staged changes. Output ONLY the message.";

/** A single summariser subprocess invocation, handed to the injectable runner. */
export interface SummariserInvocation {
  /** Resolved command line, e.g. `"claude -p"` (argv-split on whitespace). */
  command: string;
  /** Full stdin text: prompt prefix + stat summary + (truncated) staged diff. */
  input: string;
  /** Abort signal wired to the {@link AI_TIMEOUT_MS} hard cap. */
  signal: AbortSignal;
}

/**
 * Runs the summariser subprocess and resolves with its stdout. Rejects on spawn
 * error, non-zero exit, or abort. Injected in tests with a fake; defaults to
 * {@link defaultSummariserRunner}.
 */
export type SummariserRunner = (inv: SummariserInvocation) => Promise<string>;

/** Inputs for {@link composeCommitMessage}. */
export interface ComposeCommitMessageInput {
  /** Parsed staged numstat → drives the deterministic fallback stat block. */
  files: FileStat[];
  /** Full `git diff --staged` text (truncated by `max_diff_bytes` before AI). */
  stagedDiff: string;
  /** `git diff --staged --stat` human summary, included in the AI prompt. */
  statSummary?: string;
  /** The branch the commit lands on. */
  branch: string;
  /** Agent source string, e.g. `cursor` | `claude_code` | `opencode`. */
  source: string;
  /** The `commit_message` settings (mode/command/max_diff_bytes). */
  settings?: CommitMessageSettings;
}

/** Injectable dependencies for {@link composeCommitMessage} (all defaulted). */
export interface ComposeDeps {
  /** Subprocess runner. Defaults to {@link defaultSummariserRunner}. */
  runSummariser?: SummariserRunner;
  /** PATH lookup for auto-detect. Defaults to {@link defaultCommandExists}. */
  commandExists?: (bin: string) => boolean;
  /** Hard-cap override in ms. Defaults to {@link AI_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Outcome of {@link composeCommitMessage}: the message + which path produced it. */
export interface ComposeResult {
  /** The final commit message (always non-empty, ready for `git commit -F`). */
  message: string;
  /** `"ai"` when the local summariser produced it, else `"deterministic"`. */
  generator: "ai" | "deterministic";
}

/**
 * Resolve the local summariser command (PRD §2.3 detection order):
 *   1. `settings.command` (explicit user-provided) — wins if non-empty.
 *   2. Auto-detect from `source`: `claude_code` → `claude`, `cursor` →
 *      `cursor-agent`, each only if on PATH.
 *   3. Else `ollama` if present.
 * Returns `null` when nothing is configured/available (→ deterministic fallback).
 */
export function resolveSummariserCommand(
  settings: CommitMessageSettings | undefined,
  source: string,
  commandExists: (bin: string) => boolean,
): string | null {
  const explicit = settings?.command?.trim();
  if (explicit) return explicit;
  if (source === "claude_code" && commandExists("claude")) return "claude -p";
  if (source === "cursor" && commandExists("cursor-agent")) return "cursor-agent --print";
  if (commandExists("ollama")) return "ollama run llama3.2";
  return null;
}

/**
 * Sanitise raw AI output into a usable commit message (PRD §2.3):
 *   • normalise newlines, strip surrounding whitespace;
 *   • drop ``` code-fence lines wherever they appear;
 *   • drop a single leading "Here is…"/"Sure,…"/"Commit message:" preamble line;
 *   • strip an inline `Commit message:` prefix off the subject;
 *   • clamp the subject (first line) to {@link SUBJECT_MAX} chars.
 * Returns `""` for empty/garbage input so the caller uses the deterministic path.
 */
export function sanitiseAiMessage(raw: string): string {
  if (!raw) return "";
  let text = raw.replace(/\r\n/g, "\n").trim();
  if (text === "") return "";

  // Drop any code-fence marker lines (handles ```lang … ``` wrapping robustly).
  text = text
    .split("\n")
    .filter((l) => !/^\s*```/.test(l))
    .join("\n")
    .trim();

  const lines = text.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  if (lines.length === 0) return "";

  // Strip ONE leading conversational preamble off the subject — whether it sits
  // on its own line ("Here is the commit message:") or is an inline prefix on
  // the subject ("Sure! feat: …", "Commit message: chore: …"). When the line was
  // pure preamble it becomes empty and we drop it, falling through to the body.
  const PREAMBLE_PREFIX_RE =
    /^\s*(?:here(?:'s| is)\b[^\n:]*:\s*|sure[,!.:]+\s*|certainly[,!.:]*\s*|of course[,!.:]*\s*|okay[,!.:]+\s*|commit message:\s*)/i;
  lines[0] = lines[0].replace(PREAMBLE_PREFIX_RE, "");
  while (lines.length && lines[0].trim() === "") lines.shift();
  if (lines.length === 0) return "";

  // Clamp the subject (first line) to SUBJECT_MAX chars.
  lines[0] = lines[0].trim();
  if (lines[0].length > SUBJECT_MAX) lines[0] = lines[0].slice(0, SUBJECT_MAX).trimEnd();

  return lines.join("\n").trim();
}

/**
 * Truncate `diff` to at most `maxBytes` UTF-8 bytes, appending a clear marker
 * when it was cut. Best-effort: a multibyte char straddling the boundary may be
 * dropped — acceptable for a prompt hint that the AI only needs the gist of.
 */
export function truncateDiff(diff: string, maxBytes: number): string {
  const buf = Buffer.from(diff, "utf8");
  if (buf.byteLength <= maxBytes) return diff;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  return `${head}\n…[diff truncated at ${maxBytes} bytes]`;
}

/** Build the summariser stdin: prompt prefix, then the stat summary + diff. */
function buildSummariserInput(diff: string, statSummary: string): string {
  const stat = statSummary.trim();
  const statBlock = stat === "" ? "" : `\n\n${stat}`;
  return `${COMMIT_PROMPT}${statBlock}\n\n${diff}`;
}

/**
 * Default `commandExists`: true when `bin` is executable on PATH (or, if it
 * contains a path separator, executable at that exact path).
 */
export function defaultCommandExists(bin: string): boolean {
  if (bin.includes(path.sep)) {
    try {
      accessSync(bin, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      accessSync(path.join(dir, bin), fsConstants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/**
 * Default summariser runner: argv-split the command on whitespace, spawn it with
 * the prompt+diff on stdin, and resolve with stdout. The `signal` (the 8s cap)
 * is passed to spawn so an over-budget call is killed. Rejects on spawn error,
 * non-zero exit, or abort — all of which the caller maps to the fallback.
 */
export const defaultSummariserRunner: SummariserRunner = ({ command, input, signal }) =>
  new Promise<string>((resolve, reject) => {
    const argv = command.split(/\s+/).filter(Boolean);
    if (argv.length === 0) {
      reject(new Error("empty summariser command"));
      return;
    }
    const child = spawn(argv[0], argv.slice(1), { signal, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`summariser exited with code ${code}`));
    });
    // The child may exit before draining stdin; swallow the resulting EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

/**
 * Attempt the local-AI summary path. Returns the sanitised message on success,
 * or `null` for ANY non-success (disabled mode, no resolvable command, runner
 * error, timeout, empty/garbage output). Never throws.
 */
async function tryAiSummary(
  input: ComposeCommitMessageInput,
  deps: ComposeDeps,
): Promise<string | null> {
  const settings = input.settings ?? {};
  const mode = settings.mode ?? "auto";
  if (mode === "deterministic") return null;

  const commandExists = deps.commandExists ?? defaultCommandExists;
  const command = resolveSummariserCommand(settings, input.source, commandExists);
  if (!command) return null;

  const runSummariser = deps.runSummariser ?? defaultSummariserRunner;
  const timeoutMs = deps.timeoutMs ?? AI_TIMEOUT_MS;
  const maxBytes = settings.max_diff_bytes ?? DEFAULT_MAX_DIFF_BYTES;
  const stdin = buildSummariserInput(
    truncateDiff(input.stagedDiff, maxBytes),
    input.statSummary ?? "",
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const stdout = await runSummariser({ command, input: stdin, signal: controller.signal });
    const cleaned = sanitiseAiMessage(stdout ?? "");
    return cleaned === "" ? null : cleaned;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compose the commit message for `push-on-stop` (PRD §2.3). Tries the local-AI
 * summariser (subject to mode + availability + the 8s cap) and ALWAYS falls back
 * to {@link buildDeterministicMessage}. Total + non-blocking: it resolves with a
 * usable message for every input and never rejects.
 */
export async function composeCommitMessage(
  input: ComposeCommitMessageInput,
  deps: ComposeDeps = {},
): Promise<ComposeResult> {
  const ai = await tryAiSummary(input, deps);
  if (ai !== null) return { message: ai, generator: "ai" };
  return {
    message: buildDeterministicMessage({
      files: input.files,
      branch: input.branch,
      source: input.source,
    }),
    generator: "deterministic",
  };
}
