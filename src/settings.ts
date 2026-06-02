// settings.ts — the canonical GoCode Notify settings schema (PRD §3.4), mirrored
// in the TypeScript CLI. ONE source of truth for:
//   • the default settings blob (auto-push OFF, all kinds on — the conservative
//     posture from §0.5),
//   • the set of VALID dotted setting keys + their value types/enums,
//   • coercion of a CLI string value into the typed value the schema expects,
//   • the deep-merge that layers a per-repo override over the global blob (§3.4).
//
// `config.ts` (T-C5) uses this to validate `config set <key> <value>` before it
// PUTs to the server, and to merge cached global ← per-repo settings on read.
//
// Zero runtime deps — only the type system + plain objects; no Node built-ins
// needed here. Keep this in lockstep with the server validator (§3.3) and the
// Flutter `notify_settings.dart` model (§3.4, T-A1).

/** Schema version stamped into a fresh settings blob (PRD §3.4). */
export const NOTIFY_SETTINGS_VERSION = 1;

/** Per-kind notification toggles (PRD §3.4, D5). */
export interface NotifyKindToggles {
  finished?: boolean;
  error?: boolean;
  awaiting_input?: boolean;
  loop_completed?: boolean;
  loop_halted?: boolean;
}

/** Quiet-hours DND window (PRD §3.4, D5). `enabled:false` → off. */
export interface QuietHoursSettings {
  enabled?: boolean;
  /** Local wall-clock `HH:MM`, 24h. */
  start?: string;
  end?: string;
  /** IANA tz, e.g. `America/Chicago`. */
  tz?: string;
}

/** Auto-push safety/config (PRD §3.4, §0.5). `branch` appears only on merged repo blobs. */
export interface AutoPushSettings {
  enabled?: boolean;
  /** Global default branch; null/absent → use the current checked-out branch. */
  default_branch?: string | null;
  /** Per-repo override branch (override blobs only — §2.4 step 1). */
  branch?: string | null;
  /** Branch guard: block main/master unless true. */
  allow_protected?: boolean;
  remote?: string;
  skip_git_hooks?: boolean;
}

/** Commit-message generation prefs (PRD §3.4, §2.3). */
export interface CommitMessageSettings {
  mode?: "auto" | "ai" | "deterministic";
  command?: string | null;
  max_diff_bytes?: number;
}

/** The full Notify settings blob (PRD §3.4). Every field optional → partial-friendly. */
export interface NotifySettings {
  version?: number;
  kinds?: NotifyKindToggles;
  /** 0 = notify always; else only when the turn ran ≥ N seconds. */
  min_duration_seconds?: number;
  quiet_hours?: QuietHoursSettings;
  auto_push?: AutoPushSettings;
  commit_message?: CommitMessageSettings;
  [key: string]: unknown;
}

/**
 * The default global settings blob (PRD §3.4). Conservative posture (§0.5):
 * auto-push OFF, branch guard ON, every notification kind ON. Used as the
 * fail-safe when no server/cache value is available.
 */
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  version: NOTIFY_SETTINGS_VERSION,
  kinds: {
    finished: true,
    error: true,
    awaiting_input: true,
    loop_completed: true,
    loop_halted: true,
  },
  min_duration_seconds: 0,
  quiet_hours: {
    enabled: false,
    start: "23:00",
    end: "07:00",
    tz: "America/Chicago",
  },
  auto_push: {
    enabled: false,
    default_branch: null,
    allow_protected: false,
    remote: "origin",
    skip_git_hooks: false,
  },
  commit_message: {
    mode: "auto",
    command: null,
    max_diff_bytes: 61440,
  },
};

/** The value kinds a settable key can carry (drives coercion + validation). */
type ValueKind =
  | "boolean"
  | "int_nonneg" // integer ≥ 0
  | "int_pos" // integer > 0
  | "string" // non-empty string
  | "string_or_null" // non-empty string, or the literal null
  | "time" // `HH:MM` 24h
  | "enum"; // one of `enumValues`

interface KeySpec {
  kind: ValueKind;
  enumValues?: readonly string[];
  /** Only meaningful as a per-repo override (must be set with `--repo`). */
  repoOnly?: boolean;
}

/**
 * Every dotted setting key the CLI accepts in `config set <key> <value>`, with
 * the value type the schema requires. This is the allow-list: any key NOT here is
 * rejected with a helpful error (PRD §2.6 "reject unknown keys").
 */
export const KEY_SPECS: Readonly<Record<string, KeySpec>> = {
  "kinds.finished": { kind: "boolean" },
  "kinds.error": { kind: "boolean" },
  "kinds.awaiting_input": { kind: "boolean" },
  "kinds.loop_completed": { kind: "boolean" },
  "kinds.loop_halted": { kind: "boolean" },
  min_duration_seconds: { kind: "int_nonneg" },
  "quiet_hours.enabled": { kind: "boolean" },
  "quiet_hours.start": { kind: "time" },
  "quiet_hours.end": { kind: "time" },
  "quiet_hours.tz": { kind: "string" },
  "auto_push.enabled": { kind: "boolean" },
  "auto_push.default_branch": { kind: "string_or_null" },
  // Per-repo override branch — only meaningful with --repo (§2.4 step 1).
  "auto_push.branch": { kind: "string_or_null", repoOnly: true },
  "auto_push.allow_protected": { kind: "boolean" },
  "auto_push.remote": { kind: "string" },
  "auto_push.skip_git_hooks": { kind: "boolean" },
  "commit_message.mode": { kind: "enum", enumValues: ["auto", "ai", "deterministic"] },
  "commit_message.command": { kind: "string_or_null" },
  "commit_message.max_diff_bytes": { kind: "int_pos" },
};

/** Sorted list of every valid `config set` key — for help text + error messages. */
export function validKeys(): string[] {
  return Object.keys(KEY_SPECS).sort();
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Convenience shorthand: `config set quiet_hours "23:00-07:00"` (PRD §2.6 example).
const QUIET_RANGE_RE = /^([01]\d|2[0-3]:[0-5]\d|[0-2]?\d:[0-5]\d)-([0-2]?\d:[0-5]\d)$/;

/** Result of coercing/validating one `config set` argument. */
export type SetSettingResult =
  | { ok: true; partial: NotifySettings }
  | { ok: false; error: string };

function ok(partial: NotifySettings): SetSettingResult {
  return { ok: true, partial };
}
function fail(error: string): SetSettingResult {
  return { ok: false, error };
}

/** Build the nested partial blob `{ a: { b: value } }` from a dotted key path. */
function nest(key: string, value: unknown): NotifySettings {
  const parts = key.split(".");
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[parts[i]] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]] = value;
  return root as NotifySettings;
}

/** Coerce a raw CLI string into the typed value the key expects, or an error. */
function coerce(spec: KeySpec, key: string, raw: string): { value: unknown } | { error: string } {
  switch (spec.kind) {
    case "boolean": {
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return { error: `"${key}" expects a boolean (true|false), got "${raw}"` };
    }
    case "int_nonneg":
    case "int_pos": {
      if (!/^-?\d+$/.test(raw)) return { error: `"${key}" expects an integer, got "${raw}"` };
      const n = Number.parseInt(raw, 10);
      if (spec.kind === "int_nonneg" && n < 0) return { error: `"${key}" must be ≥ 0, got ${n}` };
      if (spec.kind === "int_pos" && n <= 0) return { error: `"${key}" must be > 0, got ${n}` };
      return { value: n };
    }
    case "time": {
      if (!TIME_RE.test(raw)) return { error: `"${key}" expects a time HH:MM (24h), got "${raw}"` };
      return { value: raw };
    }
    case "string": {
      if (raw.trim() === "") return { error: `"${key}" must be a non-empty string` };
      return { value: raw };
    }
    case "string_or_null": {
      if (raw === "null") return { value: null };
      if (raw.trim() === "") return { error: `"${key}" must be a non-empty string or "null"` };
      return { value: raw };
    }
    case "enum": {
      const allowed = spec.enumValues ?? [];
      if (!allowed.includes(raw)) {
        return { error: `"${key}" must be one of: ${allowed.join(", ")} (got "${raw}")` };
      }
      return { value: raw };
    }
  }
}

/**
 * Validate + coerce a single `config set <key> <value>` into the partial blob to
 * PUT to the server. `repo` indicates the write targets a per-repo override
 * (`--repo`); per-repo-only keys are rejected on the global path and vice-versa.
 *
 * Special case: the `quiet_hours` shorthand `HH:MM-HH:MM` (PRD §2.6 example)
 * expands to `{ quiet_hours: { enabled: true, start, end } }`.
 */
export function setSetting(key: string, raw: string, opts: { repo?: boolean } = {}): SetSettingResult {
  // Convenience: `quiet_hours "23:00-07:00"` → enable + start/end (PRD §2.6).
  if (key === "quiet_hours") {
    const m = raw.match(QUIET_RANGE_RE);
    if (!m) return fail(`"quiet_hours" shorthand expects "HH:MM-HH:MM" (e.g. 23:00-07:00), got "${raw}"`);
    const start = m[1].length === 2 ? `${m[1]}:00` : m[1];
    const end = m[2];
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      return fail(`"quiet_hours" times must be HH:MM (24h), got "${raw}"`);
    }
    return ok({ quiet_hours: { enabled: true, start, end } });
  }

  const spec = KEY_SPECS[key];
  if (!spec) {
    return fail(`unknown setting key "${key}". Valid keys:\n  ${validKeys().join("\n  ")}`);
  }
  if (spec.repoOnly && !opts.repo) {
    return fail(`"${key}" is a per-repo override — pass --repo to set it for the current repo`);
  }
  const c = coerce(spec, key, raw);
  if ("error" in c) return fail(c.error);
  return ok(nest(key, c.value));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `override` over `base` (PRD §3.4): nested plain objects merge
 * recursively; scalars, arrays, and explicit `null` in the override replace the
 * base value. Neither input is mutated.
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, ov] of Object.entries(override)) {
    const bv = out[k];
    if (isPlainObject(ov) && isPlainObject(bv)) {
      out[k] = deepMerge(bv, ov);
    } else {
      out[k] = ov;
    }
  }
  return out as T;
}

/**
 * Merge a per-repo override blob over the global blob (PRD §3.4 "Merge = deep-merge
 * of the override over the global blob"). Returns a new object; inputs untouched.
 */
export function mergeSettings(global: NotifySettings, override?: NotifySettings | null): NotifySettings {
  if (!override) return { ...global };
  return deepMerge(global as Record<string, unknown>, override as Record<string, unknown>) as NotifySettings;
}
