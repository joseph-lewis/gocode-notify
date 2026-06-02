#!/usr/bin/env node
// gocode-notify CLI entrypoint.
//
// This is the SCAFFOLD only (Milestone A, task 1). Individual subcommands
// (login / send / test / setup / status / mcp / uninstall) are implemented in
// later milestones. For now the entrypoint resolves help/version and reports
// not-yet-implemented for the known commands so the bin is wired and testable.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { login } from "./login.js";
import { resolveServerUrl, type PathOpts } from "./creds.js";
import {
  send,
  isNotifyKind,
  NOTIFY_KINDS,
  type SendOptions,
  type SendPayload,
} from "./send.js";
import { enqueue, flush } from "./outbox.js";
import { gatherStatus, formatStatus, formatStatusSteps } from "./status.js";
import { isAgentDriven, stdoutSink, type StepSink } from "./agent.js";
import { serveStdio, type McpDeps } from "./mcp.js";
import { setup, type SetupOptions } from "./setup.js";
import { uninstall, type UninstallOptions } from "./uninstall.js";
import { cmdConfig } from "./config.js";

/** Subcommands the finished CLI will expose (see PRD §4.1). */
export const COMMANDS = [
  "login",
  "send",
  "test",
  "setup",
  "status",
  "mcp",
  "uninstall",
  "config",
] as const;

export type Command = (typeof COMMANDS)[number];

export function printHelp(): void {
  console.log(
    [
      `gocode-notify v${VERSION}`,
      "",
      "Free phone notifications for any coding agent via the GoCode app.",
      "",
      "Usage: gocode-notify <command> [options]",
      "",
      "Commands:",
      "  login      Pair this machine with your GoCode account",
      "  send       Send a single push notification",
      "  test       Send a canned test push",
      "  setup      Pair + detect runtimes + write configs",
      "  status     Report credentials / server / detected runtimes",
      "  mcp        Run as an MCP server over stdio",
      "  uninstall  Remove entries this tool added",
      "  config     Get/set Notify settings (get | set <key> <value> | pull)",
      "",
      "  -h, --help       Show this help",
      "  -v, --version    Print the version",
      "  --agent-driven   Emit one JSON line per step (machine-readable)",
    ].join("\n"),
  );
}

/**
 * Parse `--flag value` / `--flag=value` pairs from an argv slice. A flag with no
 * following value (end of argv or another `--flag` next) becomes a boolean
 * `true`. Bare positionals are ignored — the CLI is flag-driven. Used by
 * subcommand handlers; kept tiny to honour the zero-dep rule (no arg library).
 */
export function parseFlags(argv: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

/** Read a flag as a string, or undefined when absent / passed as a bare boolean. */
function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/** Injectable dependencies for {@link cmdLogin} (lets tests stub fetch/HOME/sink). */
export interface LoginCommandDeps extends PathOpts {
  /** Injectable fetch (defaults to the global, via {@link login}). */
  fetchImpl?: typeof fetch;
  /** Timeout override in ms (defaults to login's 10s cap). */
  timeoutMs?: number;
  /** Injectable interactive code prompt (defaults to a readline prompt). */
  promptCode?: () => Promise<string>;
  /** Sink for `--agent-driven` step lines (defaults to {@link stdoutSink}). */
  sink?: StepSink;
}

/** Handle `gocode-notify login [--code N] [--label "..."] [--server URL] [--agent-driven]`. */
export async function cmdLogin(args: readonly string[], deps: LoginCommandDeps = {}): Promise<number> {
  const flags = parseFlags(args);
  const agent = isAgentDriven(flags);
  const sink = deps.sink ?? stdoutSink;

  // In agent-driven mode there is no human at the terminal: an absent --code is
  // an error, not a cue to prompt. Inject a prompt that fails fast so login()
  // returns a clean ok:false step instead of blocking on stdin (PRD §2.4).
  const promptCode =
    deps.promptCode ??
    (agent
      ? async (): Promise<string> => {
          throw new Error("--agent-driven requires --code (no interactive prompt)");
        }
      : undefined);

  const result = await login({
    code: flagString(flags, "code"),
    label: flagString(flags, "label"),
    server: flagString(flags, "server"),
    home: deps.home,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    promptCode,
  });

  if (result.ok && result.credentials) {
    if (agent) {
      sink({
        step: "login",
        ok: true,
        detail: `paired as ${result.credentials.user_id} (${result.credentials.label})`,
      });
    } else {
      console.log(`✓ Paired as ${result.credentials.user_id} (${result.credentials.label}).`);
      console.log("  Credentials saved to ~/.gocode/credentials");
    }
    return 0;
  }

  const error = result.error ?? "pairing failed";
  if (agent) {
    sink({ step: "login", ok: false, detail: error });
  } else {
    console.error(`gocode-notify login: ${error}`);
  }
  return 1;
}

/** Injectable dependencies for {@link cmdSend} (lets tests stub fetch/HOME). */
export interface SendCommandDeps extends PathOpts {
  /** Injectable fetch (defaults to the global, via {@link send}). */
  fetchImpl?: typeof fetch;
  /** Request timeout override in ms (defaults to send's 5s cap). */
  timeoutMs?: number;
  /** Timestamp source for log/outbox lines (defaults to ISO now). */
  timestamp?: () => string;
  /** Sink for `--agent-driven` step lines (defaults to {@link stdoutSink}). */
  sink?: StepSink;
}

/**
 * Handle `gocode-notify send --kind K [--title T] [--body B] [--source S]
 * [--project P] [--dedupe-key D] [--server URL]`.
 *
 * Validates `--kind` against the canonical enum (a usage error → non-zero exit,
 * since it is caught before any network and signals a misconfigured hook). Every
 * VALID send then follows the PRD §4.4 non-blocking contract: it ALWAYS exits 0,
 * even on network/server failure, so a hook never blocks the agent's turn. On a
 * delivery failure the payload is queued to the offline outbox; on a successful
 * send the backlog is flushed opportunistically (server is known reachable).
 */
export async function cmdSend(args: readonly string[], deps: SendCommandDeps = {}): Promise<number> {
  const flags = parseFlags(args);
  const agent = isAgentDriven(flags);
  const sink = deps.sink ?? stdoutSink;

  const kind = flagString(flags, "kind");
  if (kind === undefined) {
    const detail = `--kind is required (one of: ${NOTIFY_KINDS.join(", ")})`;
    if (agent) sink({ step: "validate", ok: false, detail });
    else console.error(`gocode-notify send: ${detail}`);
    return 2;
  }
  if (!isNotifyKind(kind)) {
    const detail = `invalid --kind "${kind}" (expected one of: ${NOTIFY_KINDS.join(", ")})`;
    if (agent) sink({ step: "validate", ok: false, detail });
    else console.error(`gocode-notify send: ${detail}`);
    return 2;
  }

  const payload: SendPayload = { kind };
  const title = flagString(flags, "title");
  if (title) payload.title = title;
  const body = flagString(flags, "body");
  if (body) payload.body = body;
  const source = flagString(flags, "source");
  if (source) payload.source = source;
  const project = flagString(flags, "project");
  if (project) payload.project = project;
  const dedupeKey = flagString(flags, "dedupe-key");
  if (dedupeKey) payload.dedupe_key = dedupeKey;

  const server = await resolveServerUrl(flagString(flags, "server"), deps);
  const sendOpts: SendOptions = {
    home: deps.home,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    timestamp: deps.timestamp,
    server,
  };

  const result = await send(payload, sendOpts);
  if (result.ok) {
    // Server is reachable → drain any notifications queued while offline.
    await flush((p) => send(p, sendOpts), deps);
    const where =
      typeof result.sent === "number"
        ? ` (delivered to ${result.sent} device${result.sent === 1 ? "" : "s"})`
        : "";
    if (agent) sink({ step: "send", ok: true, detail: `sent ${payload.kind}${where}` });
    else console.log(`✓ Sent ${payload.kind}${where}.`);
  } else {
    // Offline / failed → queue for the next send. Still exit 0 (non-blocking).
    await enqueue(payload, deps);
    const detail = `${payload.kind} not delivered (${result.error}); queued for retry`;
    if (agent) sink({ step: "send", ok: false, detail });
    else console.error(`gocode-notify send: ${detail}.`);
  }
  // PRD §4.4: a failed notification must NEVER block a hook — always exit 0.
  return 0;
}

/** The canned payload `gocode-notify test` sends (PRD §4.1). */
export const TEST_PAYLOAD: SendPayload = {
  kind: "finished",
  title: "GoCode test",
  body: "If you can read this on your phone, gocode-notify is working.",
  source: "manual",
};

/**
 * Handle `gocode-notify test [--server URL]`. Sends the canned {@link TEST_PAYLOAD}
 * push so a user (or an agent installer, per PRD §2 Path 2) can verify the phone
 * receives it post-install.
 *
 * Unlike {@link cmdSend} — which is wired into fire-and-forget hooks and so MUST
 * always exit 0 — `test` is an interactive diagnostic. It reports the outcome and
 * exits NON-zero on failure so the human/agent running it sees that the push did
 * not reach the server. It does not queue to the outbox (a stale "GoCode test"
 * surfacing later would be confusing); it is a clean one-shot probe.
 */
export async function cmdTest(args: readonly string[], deps: SendCommandDeps = {}): Promise<number> {
  const flags = parseFlags(args);
  const agent = isAgentDriven(flags);
  const sink = deps.sink ?? stdoutSink;
  const server = await resolveServerUrl(flagString(flags, "server"), deps);
  const sendOpts: SendOptions = {
    home: deps.home,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    timestamp: deps.timestamp,
    server,
  };

  const result = await send(TEST_PAYLOAD, sendOpts);
  if (result.ok) {
    const where =
      typeof result.sent === "number"
        ? ` (delivered to ${result.sent} device${result.sent === 1 ? "" : "s"})`
        : "";
    if (agent) sink({ step: "test", ok: true, detail: `test push sent${where}` });
    else console.log(`✓ Test push sent${where}. Check your phone for the GoCode notification.`);
    return 0;
  }
  const detail = `test push not delivered (${result.error})`;
  if (agent) sink({ step: "test", ok: false, detail });
  else console.error(`gocode-notify test: ${detail}.`);
  return 1;
}

/**
 * Handle `gocode-notify status [--server URL]`. Prints a coherent report of
 * credentials / server reachability / detected runtimes (PRD §4.1, §8). Purely
 * informational — always exits 0, even when nothing is paired or reachable.
 */
export async function cmdStatus(args: readonly string[], deps: SendCommandDeps = {}): Promise<number> {
  const flags = parseFlags(args);
  const agent = isAgentDriven(flags);
  const sink = deps.sink ?? stdoutSink;
  const report = await gatherStatus({
    home: deps.home,
    serverFlag: flagString(flags, "server"),
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  if (agent) {
    for (const step of formatStatusSteps(report)) sink(step);
  } else {
    for (const line of formatStatus(report)) console.log(line);
  }
  return 0;
}

/** True when a flag is present as a bare boolean or explicit `=true`. */
function flagBool(flags: Map<string, string | true>, name: string): boolean {
  const v = flags.get(name);
  return v === true || v === "true";
}

/** Injectable dependencies for {@link cmdSetup} (lets tests stub the orchestration). */
export interface SetupCommandDeps extends PathOpts {
  /** Injectable fetch (passed through to the pair step). */
  fetchImpl?: typeof fetch;
  /** Timeout override in ms (passed through to the pair step). */
  timeoutMs?: number;
  /** Injectable interactive code prompt (defaults to a readline prompt via login). */
  promptCode?: () => Promise<string>;
  /** Injectable pair step (defaults to {@link login} via {@link setup}). */
  pairImpl?: SetupOptions["pairImpl"];
  /** Injectable runtime detector (defaults to detectRuntimes via {@link setup}). */
  detectImpl?: SetupOptions["detectImpl"];
  /** Injectable per-runtime config writer (defaults to the pending writer). */
  writeConfig?: SetupOptions["writeConfig"];
  /** Sink for `--agent-driven` step lines (defaults to {@link stdoutSink}). */
  sink?: StepSink;
}

/**
 * Handle `gocode-notify setup [--pair-code N] [--label "..."] [--server URL]
 * [--force] [--agent-driven]`. Runs the installer orchestration (PRD §5): pair →
 * detect runtimes → write configs → summary. Idempotent; `--force` re-pairs.
 *
 * In `--agent-driven` mode each step is emitted as one JSON line and an absent
 * `--pair-code` is an error (no interactive prompt — there is no human at the
 * terminal), mirroring `cmdLogin`. Exit 0 when setup succeeded, else 1.
 */
export async function cmdSetup(args: readonly string[], deps: SetupCommandDeps = {}): Promise<number> {
  const flags = parseFlags(args);
  const agent = isAgentDriven(flags);
  const sink = deps.sink ?? stdoutSink;

  // No human at the terminal in agent-driven mode: an absent --pair-code is an
  // error, not a cue to prompt. Inject a prompt that fails fast (same contract
  // as cmdLogin) so the pair step returns a clean ok:false instead of hanging.
  const promptCode =
    deps.promptCode ??
    (agent
      ? async (): Promise<string> => {
          throw new Error("--agent-driven requires --pair-code (no interactive prompt)");
        }
      : undefined);

  const result = await setup({
    pairCode: flagString(flags, "pair-code"),
    label: flagString(flags, "label"),
    server: flagString(flags, "server"),
    force: flagBool(flags, "force"),
    home: deps.home,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    promptCode,
    pairImpl: deps.pairImpl,
    detectImpl: deps.detectImpl,
    writeConfig: deps.writeConfig,
  });

  if (agent) {
    for (const step of result.steps) sink(step);
  } else {
    console.log("gocode-notify setup");
    console.log("");
    for (const step of result.steps) {
      console.log(`  ${step.ok ? "✓" : "✗"} ${step.step}: ${step.detail}`);
    }
  }
  return result.ok ? 0 : 1;
}

/** Injectable dependencies for {@link cmdUninstall} (lets tests stub the runtime layer). */
export interface UninstallCommandDeps extends PathOpts {
  /** Injectable per-runtime uninstallers (defaults to Claude Code + Cursor). */
  uninstallers?: UninstallOptions["uninstallers"];
  /** Sink for `--agent-driven` step lines (defaults to {@link stdoutSink}). */
  sink?: StepSink;
}

/**
 * Handle `gocode-notify uninstall [--agent-driven]`. Removes EXACTLY the entries
 * this tool added to each runtime — our hooks, MCP entry, and rule/skill — while
 * preserving the user's own config (PRD §4.1, §11). Idempotent and never
 * destructive of credentials. In `--agent-driven` mode each step is emitted as
 * one JSON line. Exit 0 when every runtime uninstall succeeded (or was a clean
 * no-op), else 1.
 */
export async function cmdUninstall(
  args: readonly string[],
  deps: UninstallCommandDeps = {},
): Promise<number> {
  const flags = parseFlags(args);
  const agent = isAgentDriven(flags);
  const sink = deps.sink ?? stdoutSink;

  const result = await uninstall({ home: deps.home, uninstallers: deps.uninstallers });

  if (agent) {
    for (const step of result.steps) sink(step);
  } else {
    console.log("gocode-notify uninstall");
    console.log("");
    for (const step of result.steps) {
      console.log(`  ${step.ok ? "✓" : "✗"} ${step.step}: ${step.detail}`);
    }
  }
  return result.ok ? 0 : 1;
}

/**
 * Handle `gocode-notify mcp [--server URL]`. Runs the stdio MCP server (PRD
 * §4.3) until the client disconnects. Resolves to 0 once the connection closes
 * cleanly. Note: this is NOT `--agent-driven`-aware — MCP speaks JSON-RPC on
 * stdout, so the stream must be left untouched for the protocol.
 */
export async function cmdMcp(args: readonly string[], deps: McpDeps = {}): Promise<number> {
  const flags = parseFlags(args);
  await serveStdio({ ...deps, serverFlag: flagString(flags, "server") });
  return 0;
}

/** Synchronous dispatcher: help/version/unknown + not-yet-implemented commands. */
export function run(argv: readonly string[]): number {
  const cmd = argv[0];

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }

  if ((COMMANDS as readonly string[]).includes(cmd)) {
    console.error(`gocode-notify: command "${cmd}" is not implemented yet.`);
    return 1;
  }

  console.error(`gocode-notify: unknown command "${cmd}". Run "gocode-notify --help".`);
  return 2;
}

/**
 * Async dispatcher used by the bin entrypoint. Routes commands that perform I/O
 * (currently `login`) to their async handlers and delegates everything else to
 * the synchronous {@link run}.
 */
export async function runAsync(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === "login") return cmdLogin(argv.slice(1));
  if (cmd === "send") return cmdSend(argv.slice(1));
  if (cmd === "test") return cmdTest(argv.slice(1));
  if (cmd === "status") return cmdStatus(argv.slice(1));
  if (cmd === "setup") return cmdSetup(argv.slice(1));
  if (cmd === "mcp") return cmdMcp(argv.slice(1));
  if (cmd === "uninstall") return cmdUninstall(argv.slice(1));
  if (cmd === "config") return cmdConfig(argv.slice(1));
  return run(argv);
}

/**
 * True when this module is the process entrypoint (run as the `gocode-notify`
 * bin), false when imported (e.g. by tests). Resolves symlinks (npm installs
 * the bin as a `.bin/` symlink) and uses `fileURLToPath` so paths with spaces
 * and Windows drive paths compare correctly.
 */
export function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Only run when invoked as a binary, not when imported by tests.
if (isMainModule()) {
  runAsync(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`gocode-notify: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
