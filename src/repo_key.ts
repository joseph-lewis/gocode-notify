// `repo_key` derivation — a stable per-repo identity both the dev machine and the
// phone app agree on (PRD §2.5). Per-project auto-push overrides + the app's
// branch picker key off this so "this repo" means the same thing everywhere.
//
//   repo_key = sha256( normalize(git remote get-url origin) )[:16]
//
// normalize() lowercases, strips a trailing `.git`, and canonicalises the SCP
// form `git@github.com:owner/repo` and the URL form
// `https://github.com/owner/repo` to the SAME `github.com/owner/repo` string so
// the two clone styles of one repo derive an IDENTICAL key. If there is no
// `origin` remote we fall back to `local:<basename>` — clearly machine-local
// (not syncable across machines).
//
// Zero runtime deps beyond Node built-ins; the git runner is injectable so this
// is unit-testable with a fake `git` (no real subprocess).
import { createHash } from "node:crypto";
import path from "node:path";
import { makeGitRunner, type GitRunner } from "./push.js";

/** A derived repo identity sent alongside settings reads/writes (PRD §2.5). */
export interface RepoIdentity {
  /** The 16-hex-char stable key (sha256 prefix), or `local:<basename>`. */
  repo_key: string;
  /** Friendly `owner/repo` (origin) or the repo basename (local fallback). */
  repo_label: string;
  /**
   * true when derived from an `origin` remote (syncable across machines);
   * false for the `local:<basename>` fallback (this machine only).
   */
  synced: boolean;
}

/**
 * Canonicalise a git remote URL to a scheme-/auth-/`.git`-free
 * `host/owner/repo` string so that the SSH and HTTPS clone forms of the same
 * repo normalise IDENTICALLY (PRD §2.5). Returns "" for empty input.
 *
 * Handled forms:
 *   - `https://github.com/owner/repo(.git)`
 *   - `https://user@github.com/owner/repo`        (userinfo stripped)
 *   - `git@github.com:owner/repo(.git)`           (SCP syntax)
 *   - `ssh://git@github.com:22/owner/repo(.git)`  (scheme + port stripped)
 *   - `git://github.com/owner/repo(.git)`
 */
export function normalizeRemoteUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return "";

  // Strip any `scheme://` prefix (https, http, ssh, git, …).
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Strip `user@` / `user:pass@` userinfo (the leading authority chunk).
  s = s.replace(/^[^@/]+@/, "");

  // If a ':' precedes any '/', it separates host from either an SCP path
  // (`host:owner/repo`) or a port (`host:22/owner/repo`). Canonicalise both to
  // `host/owner/repo`.
  const colon = s.indexOf(":");
  const slash = s.indexOf("/");
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    const host = s.slice(0, colon);
    let rest = s.slice(colon + 1);
    const port = rest.match(/^(\d+)(\/.*)?$/); // `22/owner/repo` or bare `22`
    if (port) rest = port[2] ?? "";
    rest = rest.replace(/^\/+/, "");
    s = rest ? `${host}/${rest}` : host;
  }

  // Collapse duplicate slashes, drop trailing slash + `.git`, lowercase.
  s = s.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  s = s.replace(/\.git$/i, "");
  return s.toLowerCase();
}

/**
 * Derive a friendly `owner/repo` label from a normalised remote (the last two
 * path segments). Falls back to the final segment, or "" when there is none.
 */
export function repoLabelFromNormalized(normalized: string): string {
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]; // pathless — shouldn't happen for a real remote
  return parts.slice(-2).join("/");
}

/** The 16-hex-char repo key for a normalised remote URL (PRD §2.5). */
export function repoKeyFromNormalized(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Resolve this repo's {@link RepoIdentity} via the injected git runner.
 *
 *   - `git remote get-url origin` succeeds with a non-empty URL → key derived
 *     from the normalised URL; `synced: true`.
 *   - no origin (no remote, git missing, not a repo, empty URL) → fall back to
 *     `local:<basename of cwd>`; `synced: false`.
 *
 * Never throws: the runner reports failures as non-zero codes, which map to the
 * local fallback.
 */
export async function deriveRepoIdentity(
  cwd: string = process.cwd(),
  git: GitRunner = makeGitRunner(cwd),
): Promise<RepoIdentity> {
  const res = await git(["remote", "get-url", "origin"]);
  const url = res.code === 0 ? res.stdout.trim() : "";
  const normalized = normalizeRemoteUrl(url);

  if (!normalized) {
    const base = path.basename(path.resolve(cwd)) || "repo";
    return { repo_key: `local:${base}`, repo_label: base, synced: false };
  }

  return {
    repo_key: repoKeyFromNormalized(normalized),
    repo_label: repoLabelFromNormalized(normalized) || normalized,
    synced: true,
  };
}
