// `gocode-notify config get|set|pull` — the dev-machine settings editor + the
// hot-path settings resolver/cache (PRD §2.6, §2.1 step 1, §3.6).
//
// Two responsibilities live here:
//
//   1. The `config` CLI subcommand (PRD §2.6):
//        config get [--repo]                 → print merged settings (server or cache)
//        config set <key> <value> [--repo]   → validate key, PUT to server, refresh cache
//        config pull                          → force-refresh the local cache from server
//      Writes go to the server (the source of truth) AND update the local cache so
//      the next stop-hook is immediate. Keys are validated against `settings.ts`
//      (unknown keys rejected with the valid-key list).
//
//   2. The settings RESOLUTION + 60s-TTL cache the auto-push hot path needs
//      (PRD §2.1 step 1) — deferred to here by `push.ts` (T-C3). `resolveNotifySettings`
//      returns the merged blob for a repo: a fresh cache hit short-circuits the
//      network; a stale entry re-pulls; if the network is down it falls back to the
//      (possibly stale) cache; with no cache at all it returns the conservative
//      defaults (auto-push OFF — fail-safe, §0.5).
//
// The cache lives in `~/.gocode/config.json` under `notify_settings` (PRD §2.1):
//   notify_settings: { entries: { "<repo_key|__global__>": { settings, fetched_at_ms, repo_label? } } }
//
// Zero runtime deps — Node built-ins + an injectable `fetch` (so tests stub the
// network and a temp HOME stubs fs).
import {
  readConfig,
  writeConfig,
  readCredentials,
  type Config,
  type PathOpts,
} from "./creds.js";
import {
  DEFAULT_NOTIFY_SETTINGS,
  setSetting,
  type NotifySettings,
} from "./settings.js";
import { deriveRepoIdentity, type RepoIdentity } from "./repo_key.js";

/** Server paths for the Notify settings API (PRD §3.3). */
export const SETTINGS_PATH = "/api/v1/notify/settings";
export const PROJECTS_PATH = "/api/v1/notify/settings/projects";

/** Default cache TTL on the hot path (PRD §2.1 step 1: "short TTL (default 60s)"). */
export const DEFAULT_CACHE_TTL_MS = 60_000;
/** Default network timeout for `config` round-trips (mirrors `send`'s 5s cap). */
export const DEFAULT_CONFIG_TIMEOUT_MS = 5000;
/** Cache key used for the no-repo (global) entry. */
export const GLOBAL_CACHE_KEY = "__global__";

/** One cached settings entry. `settings` is the MERGED blob the server returned. */
export interface CacheEntry {
  settings: NotifySettings;
  /** Epoch ms when this entry was fetched (for TTL checks). */
  fetched_at_ms: number;
  /** Friendly repo label, when this entry is per-repo. */
  repo_label?: string;
}

/** The `notify_settings` block stored inside `~/.gocode/config.json`. */
export interface SettingsCache {
  entries: Record<string, CacheEntry>;
}

/** Where this settings read/write is scoped: the global blob, or one repo. */
export type Scope = { kind: "global" } | { kind: "repo"; repo: RepoIdentity };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeServer(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The cache key for a scope: a repo's `repo_key`, or the global sentinel. */
export function cacheKeyForScope(scope: Scope): string {
  return scope.kind === "repo" ? scope.repo.repo_key : GLOBAL_CACHE_KEY;
}

// ── cache read/write (within ~/.gocode/config.json) ──────────────────────────

function readCacheBlock(config: Config | null): SettingsCache {
  const block = config?.notify_settings;
  if (block && typeof block === "object" && !Array.isArray(block)) {
    const entries = (block as { entries?: unknown }).entries;
    if (entries && typeof entries === "object" && !Array.isArray(entries)) {
      return { entries: entries as Record<string, CacheEntry> };
    }
  }
  return { entries: {} };
}

/** Read the settings cache out of `~/.gocode/config.json` (empty when absent). */
export async function readSettingsCache(opts?: PathOpts): Promise<SettingsCache> {
  let config: Config | null = null;
  try {
    config = await readConfig(opts);
  } catch {
    // A corrupt config.json must never wedge the hot path — treat as empty cache.
    config = null;
  }
  return readCacheBlock(config);
}

/**
 * Upsert one cache entry under `~/.gocode/config.json` `notify_settings.entries`,
 * preserving every other key in config.json (round-trips unknown prefs, §0.1).
 */
export async function writeCacheEntry(
  key: string,
  entry: CacheEntry,
  opts?: PathOpts,
): Promise<void> {
  let config: Config | null = null;
  try {
    config = await readConfig(opts);
  } catch {
    config = null;
  }
  const base: Config = config ?? {};
  const cache = readCacheBlock(base);
  cache.entries[key] = entry;
  await writeConfig({ ...base, notify_settings: cache }, opts);
}

/** True when `entry` is within `ttlMs` of `now` (i.e. still fresh). */
export function isFresh(entry: CacheEntry, ttlMs: number, now: number): boolean {
  return now - entry.fetched_at_ms < ttlMs;
}

// ── network ──────────────────────────────────────────────────────────────────

/** Resolved auth + server + injectable fetch for one Notify settings round-trip. */
export interface NetContext {
  server: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function buildUrl(net: NetContext, scope: Scope, forWrite: boolean): string {
  const base = normalizeServer(net.server);
  if (scope.kind === "repo") {
    const repo = scope.repo;
    if (forWrite) {
      const q = new URLSearchParams({ repo_label: repo.repo_label });
      return `${base}${PROJECTS_PATH}/${encodeURIComponent(repo.repo_key)}?${q.toString()}`;
    }
    const q = new URLSearchParams({ repo_key: repo.repo_key, repo_label: repo.repo_label });
    return `${base}${SETTINGS_PATH}?${q.toString()}`;
  }
  return `${base}${SETTINGS_PATH}`;
}

async function request(
  net: NetContext,
  url: string,
  method: "GET" | "PUT",
  body?: unknown,
): Promise<NotifySettings> {
  const fetchImpl = net.fetchImpl ?? globalThis.fetch;
  const timeoutMs = net.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${net.apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    const json = (await res.json()) as unknown;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      return json as NotifySettings;
    }
    throw new Error("server returned a non-object settings body");
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`timeout after ${timeoutMs}ms`);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** GET the merged settings for a scope from the server (PRD §3.3). */
export async function fetchSettings(net: NetContext, scope: Scope): Promise<NotifySettings> {
  return request(net, buildUrl(net, scope, false), "GET");
}

/** PUT a partial settings blob (global) or per-repo override (PRD §3.3). */
export async function putSettings(
  net: NetContext,
  scope: Scope,
  partial: NotifySettings,
): Promise<NotifySettings> {
  return request(net, buildUrl(net, scope, true), "PUT", partial);
}

// ── resolution (hot path used by push-on-stop / on-stop dispatcher) ───────────

/** How a resolved settings blob was obtained — for logging/debugging. */
export type SettingsSource = "network" | "cache" | "default";

export interface ResolveResult {
  settings: NotifySettings;
  source: SettingsSource;
}

export interface ResolveOptions extends PathOpts {
  /** The repo to resolve for. Absent → resolve the global blob only. */
  repo?: RepoIdentity;
  /** Resolved server URL (defaults to the credentials file's `server`). */
  server?: string;
  /** Injectable fetch (defaults to the global). */
  fetchImpl?: typeof fetch;
  /** Network timeout in ms. */
  timeoutMs?: number;
  /** Cache TTL in ms (default {@link DEFAULT_CACHE_TTL_MS}). */
  ttlMs?: number;
  /** Clock source (defaults to `Date.now`), so tests pin TTL behaviour. */
  now?: () => number;
  /** Force a network pull even when the cache is fresh (`config pull`). */
  forcePull?: boolean;
}

/**
 * Resolve the merged Notify settings for a repo (PRD §2.1 step 1, §3.6). Order:
 *   1. fresh cache hit (within TTL) and not forcing → use cache (no network).
 *   2. else pull from server → cache it → return ("network").
 *   3. server unreachable / unpaired → fall back to the (possibly stale) cache.
 *   4. no cache at all → conservative DEFAULTS (auto-push OFF — fail-safe).
 * NEVER throws: the caller (a stop hook) must never be blocked by settings I/O.
 */
export async function resolveNotifySettings(opts: ResolveOptions = {}): Promise<ResolveResult> {
  const now = (opts.now ?? Date.now)();
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const scope: Scope = opts.repo ? { kind: "repo", repo: opts.repo } : { kind: "global" };
  const key = cacheKeyForScope(scope);

  const cache = await readSettingsCache(opts);
  const cached = cache.entries[key];

  if (cached && !opts.forcePull && isFresh(cached, ttlMs, now)) {
    return { settings: cached.settings, source: "cache" };
  }

  // Need a network pull. Resolve credentials; if unpaired, fall back gracefully.
  let creds;
  try {
    creds = await readCredentials(opts);
  } catch {
    creds = null;
  }
  if (creds) {
    const net: NetContext = {
      server: normalizeServer(opts.server ?? creds.server),
      apiKey: creds.api_key,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    };
    try {
      const settings = await fetchSettings(net, scope);
      await writeCacheEntry(
        key,
        {
          settings,
          fetched_at_ms: now,
          repo_label: opts.repo?.repo_label,
        },
        opts,
      ).catch(() => {});
      return { settings, source: "network" };
    } catch {
      // fall through to cache / default
    }
  }

  if (cached) return { settings: cached.settings, source: "cache" };
  return { settings: { ...DEFAULT_NOTIFY_SETTINGS }, source: "default" };
}

// ── command handlers (config get|set|pull) ────────────────────────────────────

/** Parsed `config` argv: subcommand + bare positionals + recognised flags. */
interface ParsedConfigArgs {
  sub?: string;
  positionals: string[];
  repo: boolean;
  json: boolean;
  server?: string;
}

/**
 * Parse `config <sub> [positionals] [--repo] [--json] [--server URL]`. Unlike
 * `cli.parseFlags`, this PRESERVES bare positionals (the `<key> <value>` of
 * `config set`) while still pulling the known flags out of the stream.
 */
export function parseConfigArgs(args: readonly string[]): ParsedConfigArgs {
  const out: ParsedConfigArgs = { positionals: [], repo: false, json: false };
  out.sub = args[0];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo") {
      out.repo = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--server") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.server = next;
        i++;
      }
    } else if (a.startsWith("--server=")) {
      out.server = a.slice("--server=".length);
    } else if (a.startsWith("--")) {
      // Unknown flag — ignore (keeps positionals clean).
    } else {
      out.positionals.push(a);
    }
  }
  return out;
}

/** Injectable deps for {@link cmdConfig} (lets tests stub fetch / HOME / output). */
export interface ConfigCommandDeps extends PathOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Cache TTL override. */
  ttlMs?: number;
  /** Clock source for cache stamping (defaults to `Date.now`). */
  now?: () => number;
  /** stdout sink (defaults to `console.log`). */
  out?: (line: string) => void;
  /** stderr sink (defaults to `console.error`). */
  err?: (line: string) => void;
  /** Injectable repo-identity resolver (defaults to {@link deriveRepoIdentity}). */
  deriveRepo?: (cwd?: string) => Promise<RepoIdentity>;
  /** Working directory for repo derivation (defaults to `process.cwd()`). */
  cwd?: string;
}

async function resolveScope(parsed: ParsedConfigArgs, deps: ConfigCommandDeps): Promise<Scope> {
  if (!parsed.repo) return { kind: "global" };
  const derive = deps.deriveRepo ?? ((cwd?: string) => deriveRepoIdentity(cwd ?? process.cwd()));
  const repo = await derive(deps.cwd);
  return { kind: "repo", repo };
}

async function netFromCreds(
  parsed: ParsedConfigArgs,
  deps: ConfigCommandDeps,
): Promise<NetContext | { error: string }> {
  let creds;
  try {
    creds = await readCredentials(deps);
  } catch (e) {
    return { error: `credentials unreadable: ${errMessage(e)}` };
  }
  if (!creds) return { error: "not paired — run `gocode-notify login` first" };
  return {
    server: normalizeServer(parsed.server ?? creds.server),
    apiKey: creds.api_key,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  };
}

/**
 * Handle `gocode-notify config get|set|pull`. Interactive diagnostic — exits
 * non-zero on a usage/validation/IO error so the human/agent sees it (unlike the
 * fire-and-forget hooks which always exit 0).
 */
export async function cmdConfig(args: readonly string[], deps: ConfigCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const parsed = parseConfigArgs(args);

  switch (parsed.sub) {
    case "get":
      return cmdConfigGet(parsed, deps, out, err);
    case "set":
      return cmdConfigSet(parsed, deps, out, err);
    case "pull":
      return cmdConfigPull(parsed, deps, out, err);
    default:
      err(
        `gocode-notify config: expected a subcommand (get | set | pull), got "${parsed.sub ?? ""}"`,
      );
      return 2;
  }
}

async function cmdConfigGet(
  parsed: ParsedConfigArgs,
  deps: ConfigCommandDeps,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const scope = await resolveScope(parsed, deps);
  const result = await resolveNotifySettings({
    home: deps.home,
    repo: scope.kind === "repo" ? scope.repo : undefined,
    server: parsed.server,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    ttlMs: deps.ttlMs,
    now: deps.now,
  });
  out(JSON.stringify(result.settings, null, 2));
  if (result.source === "default") {
    err("gocode-notify config get: server unreachable and no cache — showing defaults");
  }
  return 0;
}

async function cmdConfigSet(
  parsed: ParsedConfigArgs,
  deps: ConfigCommandDeps,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const [key, ...valueParts] = parsed.positionals;
  if (key === undefined || valueParts.length === 0) {
    err("gocode-notify config set: usage: config set <key> <value> [--repo]");
    return 2;
  }
  const value = valueParts.join(" ");
  const validated = setSetting(key, value, { repo: parsed.repo });
  if (!validated.ok) {
    err(`gocode-notify config set: ${validated.error}`);
    return 2;
  }

  const scope = await resolveScope(parsed, deps);
  const net = await netFromCreds(parsed, deps);
  if ("error" in net) {
    err(`gocode-notify config set: ${net.error}`);
    return 1;
  }

  let merged: NotifySettings;
  try {
    merged = await putSettings(net, scope, validated.partial);
  } catch (e) {
    err(`gocode-notify config set: write failed (${errMessage(e)})`);
    return 1;
  }

  // Refresh the local cache immediately so the next stop-hook honours it (§2.6).
  const now = (deps.now ?? Date.now)();
  await writeCacheEntry(
    cacheKeyForScope(scope),
    {
      settings: merged,
      fetched_at_ms: now,
      repo_label: scope.kind === "repo" ? scope.repo.repo_label : undefined,
    },
    deps,
  ).catch(() => {});

  const where = scope.kind === "repo" ? ` for ${scope.repo.repo_label}` : "";
  out(`✓ Set ${key}=${value}${where}.`);
  return 0;
}

async function cmdConfigPull(
  parsed: ParsedConfigArgs,
  deps: ConfigCommandDeps,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const scope = await resolveScope(parsed, deps);
  const result = await resolveNotifySettings({
    home: deps.home,
    repo: scope.kind === "repo" ? scope.repo : undefined,
    server: parsed.server,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    ttlMs: deps.ttlMs,
    now: deps.now,
    forcePull: true,
  });
  if (result.source !== "network") {
    err("gocode-notify config pull: server unreachable — local cache unchanged");
    return 1;
  }
  out(JSON.stringify(result.settings, null, 2));
  out(`✓ Pulled latest settings${scope.kind === "repo" ? ` for ${scope.repo.repo_label}` : ""}.`);
  return 0;
}
