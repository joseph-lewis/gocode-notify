// gocode-notify `login` — device pairing flow (PRD §1.1, §4.1, §5.1).
//
// Exchanges a 6-digit pairing code (shown in the GoCode app's "Connect a coding
// agent" screen) for a scoped push-only API key via
//   POST /api/v1/notify/pair/claim   (NO JWT — the CLI has none yet)
// then writes ~/.gocode/credentials (chmod 600) so every later `send` is
// authenticated. When `--code` is absent the code is read interactively.
//
// The server URL follows the same precedence as everywhere else:
//   --server flag  >  GOCODE_SERVER env  >  credentials file  >  built-in default
// (resolved via resolveServerUrl in creds.ts).
//
// Zero runtime deps — only Node built-ins, to match the package's zero-dep rule.
import os from "node:os";
import { createInterface } from "node:readline/promises";
import {
  resolveServerUrl,
  writeCredentials,
  type Credentials,
  type PathOpts,
} from "./creds.js";

/** Endpoint the CLI hits to exchange a pairing code for an API key (PRD §3.2). */
export const CLAIM_PATH = "/api/v1/notify/pair/claim";

/**
 * Default timeout for the claim request. Longer than `send`'s 5s because login
 * is an explicit, user-initiated action (not a fire-and-forget hook), so a
 * brief extra wait is acceptable and surfaces a clearer failure than a clip.
 */
export const LOGIN_TIMEOUT_MS = 10_000;

/** The fields the server returns from `/pair/claim` (PRD §3.2). */
export interface ClaimResponse {
  api_key: string;
  user_id: string;
  /** Server echoes the label we sent; may be absent — we fall back locally. */
  label?: string;
}

/** Inputs to {@link login}. */
export interface LoginOptions extends PathOpts {
  /** The 6-digit pairing code. When absent, read interactively via `promptCode`. */
  code?: string;
  /** Human label for this machine/agent (defaults to the hostname). */
  label?: string;
  /** `--server` flag override (else GOCODE_SERVER / creds / built-in default). */
  server?: string;
  /** Injectable fetch (defaults to the global). Lets tests stub the network. */
  fetchImpl?: typeof fetch;
  /** Timeout override in ms (defaults to {@link LOGIN_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Injectable interactive code prompt (defaults to a readline prompt). */
  promptCode?: () => Promise<string>;
}

/** Outcome of a {@link login} attempt. Never thrown — always returned. */
export interface LoginResult {
  /** True only when pairing succeeded and credentials were written. */
  ok: boolean;
  /** The credentials written on success. */
  credentials?: Credentials;
  /** HTTP status, when a response was received. */
  status?: number;
  /** Human-readable failure reason. */
  error?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strip trailing slashes so `${server}/path` is always clean. */
function normalizeServer(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** First non-empty (after trim) string, else undefined. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/** A short, friendly default label for this machine (hostname, sans domain). */
export function defaultLabel(): string {
  const host = os.hostname().split(".")[0];
  return firstNonEmpty(host) ?? "this machine";
}

/** Read a 6-digit code from the terminal (the non-test, interactive path). */
async function defaultPromptCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question("Enter the 6-digit pairing code from the GoCode app: ");
  } finally {
    rl.close();
  }
}

function isClaimResponse(value: unknown): value is ClaimResponse {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.api_key === "string" && typeof r.user_id === "string";
}

/** Result of a {@link claim} call: discriminated on `ok`. */
export type ClaimResult =
  | { ok: true; data: ClaimResponse }
  | { ok: false; status?: number; error: string };

/**
 * Exchange a pairing `code` for an API key at `POST /pair/claim`. No JWT and no
 * API key are sent (this is the unauthenticated bootstrap). Resolves (never
 * rejects) to a {@link ClaimResult}; failures carry a generic message because
 * the server intentionally does not leak which condition failed (PRD §3.2).
 */
export async function claim(
  code: string,
  label: string,
  opts: { server: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<ClaimResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = `${normalizeServer(opts.server)}${CLAIM_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `pairing failed (server responded ${res.status}) — check the code and try again`,
      };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { ok: false, status: res.status, error: "pairing response was not valid JSON" };
    }
    if (!isClaimResponse(data)) {
      return { ok: false, status: res.status, error: "pairing response missing api_key/user_id" };
    }
    return { ok: true, data };
  } catch (err) {
    const reason = controller.signal.aborted
      ? "pairing request timed out"
      : `pairing request failed: ${errMessage(err)}`;
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the full `login` flow: resolve the server, obtain the 6-digit code (flag
 * or interactive prompt), claim an API key, and write ~/.gocode/credentials.
 * Credentials are written ONLY on success. Resolves (never rejects) to a
 * {@link LoginResult}.
 */
export async function login(opts: LoginOptions = {}): Promise<LoginResult> {
  const server = await resolveServerUrl(opts.server, opts);

  // Resolve the code. Prompt ONLY when the --code flag is truly absent
  // (undefined). An explicitly-supplied-but-empty code must NOT silently fall
  // into the interactive prompt — it falls through to validation and is
  // rejected, so a bad `--code ""` never hangs on stdin.
  let code = opts.code;
  if (code === undefined) {
    const prompt = opts.promptCode ?? defaultPromptCode;
    try {
      code = await prompt();
    } catch (err) {
      return { ok: false, error: `could not read pairing code: ${errMessage(err)}` };
    }
  }
  code = code.trim();
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "pairing code must be 6 digits" };
  }

  const label = firstNonEmpty(opts.label) ?? defaultLabel();

  const result = await claim(code, label, {
    server,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error };
  }

  const creds: Credentials = {
    api_key: result.data.api_key,
    server,
    user_id: result.data.user_id,
    // Prefer the label the server echoed back; fall back to the one we sent.
    label: firstNonEmpty(result.data.label, label) ?? label,
  };
  await writeCredentials(creds, opts);
  return { ok: true, credentials: creds };
}
