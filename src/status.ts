// `gocode-notify status` — a coherent at-a-glance report (PRD §4.1, §8):
//   - credentials present? (and the bound user/label)
//   - server reachable? (a short, non-blocking probe)
//   - which agent runtimes are detected on this machine?
//   - have their config files been written?
//
// This module gathers the report into a plain {@link StatusReport} object and
// renders it human-readably. Keeping the gather/format split lets the later
// `--agent-driven` task emit the SAME report as JSON without re-collecting it.
//
// Runtime detection is delegated to the canonical {@link detectRuntimes} in
// `detect.ts` (fixture-HOME tested there, PRD §5.2). `status` re-exports the
// runtime types/table for backward-compatible imports and only consumes the
// detector to build its summary.
//
// Zero runtime deps — Node built-ins only, matching the package's zero-dep rule.
import {
  credentialsPath,
  readCredentials,
  resolveServerUrl,
  type Credentials,
  type PathOpts,
} from "./creds.js";
import { detectRuntimes, type RuntimeStatus } from "./detect.js";
import type { StepLine } from "./agent.js";

// Re-exported so existing `from "./status.js"` imports keep working after the
// detector moved to its own module.
export { detectRuntimes, RUNTIMES } from "./detect.js";
export type { RuntimeSpec, RuntimeStatus } from "./detect.js";

/** Default reachability-probe timeout. Short so `status` never blocks a shell. */
export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

/** Health endpoint hit by the reachability probe (any HTTP response = up). */
export const HEALTH_PATH = "/api/health";

/** Credentials portion of the report. */
export interface CredsStatus {
  present: boolean;
  path: string;
  user_id?: string;
  label?: string;
  server?: string;
  /** Set when the file exists but is unreadable/malformed. */
  error?: string;
}

/** Server-reachability portion of the report. */
export interface ServerStatus {
  url: string;
  reachable: boolean;
  /** Human-readable probe outcome (e.g. "HTTP 200", "timeout after 3000ms"). */
  detail: string;
}

/** The full status report. */
export interface StatusReport {
  credentials: CredsStatus;
  server: ServerStatus;
  runtimes: RuntimeStatus[];
}

/** Options for {@link gatherStatus}. */
export interface StatusOptions extends PathOpts {
  /** `--server` flag (highest server-URL precedence, per `resolveServerUrl`). */
  serverFlag?: string;
  /** Injectable fetch for the reachability probe (defaults to the global). */
  fetchImpl?: typeof fetch;
  /** Probe timeout override in ms (defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}). */
  timeoutMs?: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probe `${url}${HEALTH_PATH}` to decide reachability. ANY HTTP response (even a
 * 404) counts as reachable — we only care that the host answered. A network
 * error or timeout is unreachable. Never throws.
 */
export async function probeServer(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ reachable: boolean; detail: string }> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}${HEALTH_PATH}`, {
      method: "GET",
      signal: controller.signal,
    });
    return { reachable: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    const detail = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : errMessage(err);
    return { reachable: false, detail };
  } finally {
    clearTimeout(timer);
  }
}

/** Gather the full {@link StatusReport}. Never throws (collects errors inline). */
export async function gatherStatus(opts: StatusOptions = {}): Promise<StatusReport> {
  const pathOpts: PathOpts = { home: opts.home };

  // Credentials: distinguish absent (present:false, no error) from malformed
  // (present:false, error set) so the report can tell the user which to fix.
  const credsStatus: CredsStatus = { present: false, path: credentialsPath(pathOpts) };
  let creds: Credentials | null = null;
  try {
    creds = await readCredentials(pathOpts);
  } catch (err) {
    credsStatus.error = errMessage(err);
  }
  if (creds) {
    credsStatus.present = true;
    credsStatus.user_id = creds.user_id;
    credsStatus.label = creds.label;
    credsStatus.server = creds.server;
  }

  // Server URL via the standard precedence chain (flag > env > creds > default),
  // then probe it.
  const url = await resolveServerUrl(opts.serverFlag, pathOpts);
  const probe = await probeServer(url, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });

  const runtimes = await detectRuntimes(pathOpts);

  return {
    credentials: credsStatus,
    server: { url, reachable: probe.reachable, detail: probe.detail },
    runtimes,
  };
}

function mark(ok: boolean): string {
  return ok ? "✓" : "✗";
}

/** Render a {@link StatusReport} as human-readable lines (one per element). */
export function formatStatus(report: StatusReport): string[] {
  const lines: string[] = ["gocode-notify status", ""];

  const c = report.credentials;
  if (c.present) {
    lines.push(`${mark(true)} Credentials: paired as ${c.user_id} (${c.label})`);
  } else if (c.error) {
    lines.push(`${mark(false)} Credentials: unreadable — ${c.error}`);
  } else {
    lines.push(`${mark(false)} Credentials: not paired — run \`gocode-notify login\``);
  }
  lines.push(`    path: ${c.path}`);

  lines.push(
    `${mark(report.server.reachable)} Server: ${report.server.url} (${report.server.detail})`,
  );

  lines.push("", "Runtimes:");
  for (const r of report.runtimes) {
    if (!r.detected) {
      lines.push(`  ${mark(false)} ${r.name}: not detected`);
      continue;
    }
    const cfg = r.configWritten ? "config written" : "no config yet";
    lines.push(`  ${mark(true)} ${r.name}: detected (${cfg})`);
    lines.push(`      config: ${r.configPath}`);
  }

  return lines;
}

/**
 * Render a {@link StatusReport} as `--agent-driven` step lines (PRD §4.4): one
 * line per report element — `credentials`, `server`, then `runtime:<name>` for
 * each runtime — so an agent can parse the same report `formatStatus` renders
 * for humans. `ok` reflects whether that element is in the desired state
 * (paired / reachable / detected).
 */
export function formatStatusSteps(report: StatusReport): StepLine[] {
  const steps: StepLine[] = [];

  const c = report.credentials;
  steps.push({
    step: "credentials",
    ok: c.present,
    detail: c.present
      ? `paired as ${c.user_id} (${c.label})`
      : c.error
        ? `unreadable — ${c.error}`
        : "not paired",
  });

  steps.push({
    step: "server",
    ok: report.server.reachable,
    detail: `${report.server.url} (${report.server.detail})`,
  });

  for (const r of report.runtimes) {
    steps.push({
      step: `runtime:${r.name}`,
      ok: r.detected,
      detail: r.detected
        ? r.configWritten
          ? "detected (config written)"
          : "detected (no config yet)"
        : "not detected",
    });
  }

  return steps;
}
