// Credentials + config storage for gocode-notify (PRD §4.2).
//
// Two files live under `~/.gocode/`:
//   - credentials  JSON { api_key, server, user_id, label } — chmod 600 (secret)
//   - config.json  non-secret prefs { server?, source? }
//
// Server-URL precedence (PRD §4.2, the acceptance criterion for this task):
//   --server flag  >  GOCODE_SERVER env  >  credentials file  >  built-in default
//
// Zero runtime deps — only Node built-ins, to match the package's zero-dep rule.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Built-in default server, used when nothing else resolves a URL. */
export const DEFAULT_SERVER = "https://oh.jeltechsolutions.com";

/** Secret pairing credentials written by `login` / `setup`. */
export interface Credentials {
  api_key: string;
  server: string;
  user_id: string;
  label: string;
}

/** Non-secret user preferences. Extra keys are preserved on round-trip. */
export interface Config {
  server?: string;
  source?: string;
  [key: string]: unknown;
}

/** Optional override for the home directory — lets tests target a temp HOME. */
export interface PathOpts {
  home?: string;
}

/**
 * Resolve the home directory. Prefers an explicit override, then `$HOME`
 * (so tests can point at a temp dir via the env), then `os.homedir()`.
 */
export function resolveHome(opts?: PathOpts): string {
  return opts?.home ?? process.env.HOME ?? os.homedir();
}

/** Absolute path to the `~/.gocode/` directory. */
export function gocodeDir(opts?: PathOpts): string {
  return path.join(resolveHome(opts), ".gocode");
}

/** Absolute path to the secret credentials file. */
export function credentialsPath(opts?: PathOpts): string {
  return path.join(gocodeDir(opts), "credentials");
}

/** Absolute path to the non-secret config file. */
export function configPath(opts?: PathOpts): string {
  return path.join(gocodeDir(opts), "config.json");
}

/** Trim a URL and strip any trailing slashes (so `${server}/path` is clean). */
function normalizeServer(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** First value that is a non-empty string after trimming; else undefined. */
function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

async function ensureGocodeDir(opts?: PathOpts): Promise<void> {
  // 0o700: the dir holds a secret; keep it owner-only.
  await fs.mkdir(gocodeDir(opts), { recursive: true, mode: 0o700 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`gocode-notify: ${file} contains invalid JSON`);
  }
}

/**
 * Read `~/.gocode/credentials`. Returns null when the file does not exist.
 * Throws if it exists but is not a JSON object with the required string fields.
 */
export async function readCredentials(opts?: PathOpts): Promise<Credentials | null> {
  const parsed = await readJsonFile(credentialsPath(opts));
  if (parsed === undefined) return null;
  if (!isRecord(parsed)) {
    throw new Error(`gocode-notify: ${credentialsPath(opts)} is not a JSON object`);
  }
  for (const field of ["api_key", "server", "user_id", "label"] as const) {
    if (typeof parsed[field] !== "string") {
      throw new Error(`gocode-notify: credentials missing string field "${field}"`);
    }
  }
  return {
    api_key: parsed.api_key as string,
    server: parsed.server as string,
    user_id: parsed.user_id as string,
    label: parsed.label as string,
  };
}

/**
 * Write `~/.gocode/credentials` with mode 0o600 (owner read/write only).
 * Creates `~/.gocode/` (0o700) if needed.
 */
export async function writeCredentials(creds: Credentials, opts?: PathOpts): Promise<void> {
  await ensureGocodeDir(opts);
  const file = credentialsPath(opts);
  const body = JSON.stringify(creds, null, 2) + "\n";
  // mode on writeFile is masked by umask, so chmod explicitly afterwards to
  // guarantee 0o600 regardless of the caller's umask.
  await fs.writeFile(file, body, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/**
 * Read `~/.gocode/config.json`. Returns null when absent. Throws if it exists
 * but is not a JSON object.
 */
export async function readConfig(opts?: PathOpts): Promise<Config | null> {
  const parsed = await readJsonFile(configPath(opts));
  if (parsed === undefined) return null;
  if (!isRecord(parsed)) {
    throw new Error(`gocode-notify: ${configPath(opts)} is not a JSON object`);
  }
  return parsed as Config;
}

/** Write `~/.gocode/config.json` (non-secret; default 0o644 perms). */
export async function writeConfig(config: Config, opts?: PathOpts): Promise<void> {
  await ensureGocodeDir(opts);
  const body = JSON.stringify(config, null, 2) + "\n";
  await fs.writeFile(configPath(opts), body);
}

/** Inputs to {@link resolveServer}, in descending precedence order. */
export interface ServerSources {
  /** `--server` CLI flag. */
  flag?: string | null;
  /** Value of the `GOCODE_SERVER` environment variable. */
  env?: string | null;
  /** Parsed credentials file (its `server` field is used). */
  creds?: { server?: string } | null;
  /** Override the built-in default (defaults to {@link DEFAULT_SERVER}). */
  default?: string;
}

/**
 * Resolve the effective server URL from the precedence chain
 * `flag > env > creds.server > default`. Empty/whitespace values are skipped.
 * The result is trimmed and has trailing slashes stripped.
 */
export function resolveServer(sources: ServerSources): string {
  const chosen = firstNonEmpty(
    sources.flag,
    sources.env,
    sources.creds?.server,
    sources.default ?? DEFAULT_SERVER,
  );
  // The default is always non-empty, so `chosen` is defined here.
  return normalizeServer(chosen ?? DEFAULT_SERVER);
}

/**
 * Convenience wrapper: resolve the server URL using the `--server` flag, the
 * live `GOCODE_SERVER` env var, and the on-disk credentials file.
 */
export async function resolveServerUrl(
  flag?: string,
  opts?: PathOpts,
): Promise<string> {
  // Credentials are the LOWEST non-default precedence tier, so a corrupt or
  // unreadable credentials file must never block a higher-precedence --server
  // flag or GOCODE_SERVER env. Swallow read errors here and treat them as
  // "no creds" — callers that actually need a valid api_key (e.g. `send`)
  // call readCredentials() directly and get the strict error there.
  let creds: Credentials | null = null;
  try {
    creds = await readCredentials(opts);
  } catch {
    creds = null;
  }
  return resolveServer({
    flag,
    env: process.env.GOCODE_SERVER ?? null,
    creds,
  });
}
