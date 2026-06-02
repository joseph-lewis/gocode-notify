// Internal send() — the single code path every trigger (hook / loop / MCP / CLI)
// funnels through to POST `/api/v1/notify/send` (PRD §3.2, §4.4).
//
// Contract (PRD §4.4 "Never block the agent"):
//   - Hard timeout (default 5s) via AbortController.
//   - NEVER throws and NEVER rejects — always resolves to a {@link SendResult}.
//     A failed notification must never block a hook's turn or fail a loop.
//   - Failures are appended to `~/.gocode/notify.log` (size-capped + rotated).
//
// This module owns ONLY the request build + timeout + logging. The CLI `send`
// command (kind-enum validation, flag parsing) and the offline outbox are
// separate tasks; this stays self-contained and dependency-free.
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_SERVER,
  gocodeDir,
  readCredentials,
  type PathOpts,
} from "./creds.js";

/** Canonical notification kinds accepted by `/notify/send` (PRD §3.2). */
export const NOTIFY_KINDS = [
  "finished",
  "error",
  "awaiting_input",
  "loop_completed",
  "loop_halted",
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** True when `value` is one of the canonical {@link NOTIFY_KINDS}. */
export function isNotifyKind(value: unknown): value is NotifyKind {
  return typeof value === "string" && (NOTIFY_KINDS as readonly string[]).includes(value);
}

/** The body posted to `/notify/send` (PRD §3.2). Optional fields are omitted. */
export interface SendPayload {
  kind: NotifyKind;
  title?: string;
  body?: string;
  source?: string;
  project?: string;
  dedupe_key?: string;
}

/** Outcome of a send attempt. `ok` reflects delivery to the server (HTTP 2xx). */
export interface SendResult {
  /** True only on a 2xx response. False on any error, timeout, or non-2xx. */
  ok: boolean;
  /** HTTP status code, when a response was received. */
  status?: number;
  /** `sent` count parsed from the server response body, when present. */
  sent?: number;
  /** Human-readable failure reason (also written to the log). */
  error?: string;
}

/** Default request timeout (PRD §4.4: 5s hard cap). */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Rotate `notify.log` once it grows past this (keeps one `.1` backup). */
export const MAX_LOG_BYTES = 256 * 1024;

export interface SendOptions extends PathOpts {
  /**
   * Explicit, already-resolved server URL. When absent, the credentials file's
   * `server` field is used (callers wanting full --server/env precedence should
   * resolve it first via `resolveServerUrl` and pass it here).
   */
  server?: string;
  /** Injectable fetch (defaults to the global). Lets tests stub the network. */
  fetchImpl?: typeof fetch;
  /** Timeout override in ms (defaults to {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Timestamp source for log lines (defaults to ISO now). Eases test asserts. */
  timestamp?: () => string;
}

/** Absolute path to the failure log. */
export function notifyLogPath(opts?: PathOpts): string {
  return path.join(gocodeDir(opts), "notify.log");
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Strip trailing slashes so `${server}/path` is always clean. */
function normalizeServer(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Build the JSON body, dropping any undefined/empty optional fields. */
function buildBody(payload: SendPayload): Record<string, string> {
  const body: Record<string, string> = { kind: payload.kind };
  for (const field of ["title", "body", "source", "project", "dedupe_key"] as const) {
    const v = payload[field];
    if (typeof v === "string" && v !== "") body[field] = v;
  }
  return body;
}

/**
 * Append one line to `~/.gocode/notify.log`. Best-effort: any error here is
 * swallowed — logging must never be the thing that blocks a notification.
 * Rotates to `notify.log.1` once the file exceeds {@link MAX_LOG_BYTES}.
 */
export async function appendLog(line: string, opts?: SendOptions): Promise<void> {
  try {
    await fs.mkdir(gocodeDir(opts), { recursive: true, mode: 0o700 });
    const file = notifyLogPath(opts);
    try {
      const st = await fs.stat(file);
      if (st.size > MAX_LOG_BYTES) {
        // Overwrite any prior backup; keep exactly one rotation.
        await fs.rename(file, `${file}.1`).catch(() => {});
      }
    } catch {
      // No existing log → nothing to rotate.
    }
    const ts = opts?.timestamp ? opts.timestamp() : new Date().toISOString();
    await fs.appendFile(file, `${ts} ${line}\n`);
  } catch {
    // Intentionally silent — see contract above.
  }
}

async function failure(reason: string, opts: SendOptions, extra: Partial<SendResult> = {}): Promise<SendResult> {
  await appendLog(`SEND FAIL: ${reason}`, opts);
  return { ok: false, error: reason, ...extra };
}

/**
 * Send one push to `/notify/send`. Resolves (never rejects) to a
 * {@link SendResult}; callers may treat ANY result as "exit 0".
 */
export async function send(payload: SendPayload, opts: SendOptions = {}): Promise<SendResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  let creds;
  try {
    creds = await readCredentials(opts);
  } catch (err) {
    return failure(`credentials unreadable: ${errMessage(err)}`, opts);
  }
  if (!creds) {
    return failure("not paired — run `gocode-notify login` first", opts);
  }

  const server = normalizeServer(opts.server ?? creds.server ?? DEFAULT_SERVER);
  const url = `${server}/api/v1/notify/send`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds.api_key}`,
      },
      body: JSON.stringify(buildBody(payload)),
      signal: controller.signal,
    });

    if (!res.ok) {
      return failure(`server responded ${res.status} for kind=${payload.kind}`, opts, {
        status: res.status,
      });
    }

    let sent: number | undefined;
    try {
      const json = (await res.json()) as { sent?: unknown };
      if (typeof json?.sent === "number") sent = json.sent;
    } catch {
      // A 2xx with an unparseable body still counts as delivered.
    }
    return { ok: true, status: res.status, sent };
  } catch (err) {
    const reason = controller.signal.aborted
      ? `timeout after ${timeoutMs}ms for kind=${payload.kind}`
      : `request failed: ${errMessage(err)}`;
    return failure(reason, opts);
  } finally {
    clearTimeout(timer);
  }
}
