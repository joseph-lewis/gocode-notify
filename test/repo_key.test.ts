import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRemoteUrl,
  repoKeyFromNormalized,
  repoLabelFromNormalized,
  deriveRepoIdentity,
} from "../src/repo_key.js";
import type { GitResult, GitRunner } from "../src/push.js";

// ── test doubles ────────────────────────────────────────────────────────────

/** A fake git runner: routes by argv, records calls. Never rejects. */
function fakeGit(route: (args: string[]) => Partial<GitResult> | undefined): {
  runner: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    const a = [...args];
    calls.push(a);
    const r = route(a) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}

/** Routes `remote get-url origin` to a fixed URL (exit 0). */
function originUrl(url: string): GitRunner {
  return fakeGit((args) =>
    args.join(" ") === "remote get-url origin" ? { stdout: `${url}\n` } : undefined,
  ).runner;
}

// ── normalizeRemoteUrl ──────────────────────────────────────────────────────

test("normalize: ssh and https forms of the same repo canonicalise identically", () => {
  const ssh = normalizeRemoteUrl("git@github.com:owner/repo.git");
  const https = normalizeRemoteUrl("https://github.com/owner/repo.git");
  assert.equal(ssh, "github.com/owner/repo");
  assert.equal(https, "github.com/owner/repo");
  assert.equal(ssh, https);
});

test("normalize: strips trailing .git and lowercases the host+path", () => {
  assert.equal(normalizeRemoteUrl("https://GitHub.com/Owner/Repo.git"), "github.com/owner/repo");
  assert.equal(normalizeRemoteUrl("git@GitHub.com:Owner/Repo"), "github.com/owner/repo");
});

test("normalize: strips userinfo from https URLs", () => {
  assert.equal(
    normalizeRemoteUrl("https://x-access-token:ghp_secret@github.com/owner/repo.git"),
    "github.com/owner/repo",
  );
  assert.equal(normalizeRemoteUrl("https://user@github.com/owner/repo"), "github.com/owner/repo");
});

test("normalize: ssh:// scheme with explicit port matches the scp form", () => {
  const scheme = normalizeRemoteUrl("ssh://git@github.com:22/owner/repo.git");
  const scp = normalizeRemoteUrl("git@github.com:owner/repo.git");
  assert.equal(scheme, "github.com/owner/repo");
  assert.equal(scheme, scp);
});

test("normalize: git:// protocol and trailing slash", () => {
  assert.equal(normalizeRemoteUrl("git://github.com/owner/repo.git/"), "github.com/owner/repo");
});

test("normalize: deep paths (e.g. GitLab subgroups) keep full path", () => {
  assert.equal(
    normalizeRemoteUrl("git@gitlab.com:group/subgroup/repo.git"),
    "gitlab.com/group/subgroup/repo",
  );
  assert.equal(
    normalizeRemoteUrl("https://gitlab.com/group/subgroup/repo"),
    "gitlab.com/group/subgroup/repo",
  );
});

test("normalize: empty / whitespace input returns empty string", () => {
  assert.equal(normalizeRemoteUrl(""), "");
  assert.equal(normalizeRemoteUrl("   "), "");
});

// ── key + label helpers ─────────────────────────────────────────────────────

test("repoKeyFromNormalized: 16 lowercase hex chars, deterministic", () => {
  const k = repoKeyFromNormalized("github.com/owner/repo");
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(k, repoKeyFromNormalized("github.com/owner/repo"));
});

test("repoKeyFromNormalized: ssh and https forms yield the SAME key", () => {
  const kSsh = repoKeyFromNormalized(normalizeRemoteUrl("git@github.com:owner/repo.git"));
  const kHttps = repoKeyFromNormalized(normalizeRemoteUrl("https://github.com/owner/repo.git"));
  assert.equal(kSsh, kHttps);
});

test("repoKeyFromNormalized: different repos yield different keys", () => {
  assert.notEqual(
    repoKeyFromNormalized("github.com/owner/repo"),
    repoKeyFromNormalized("github.com/owner/other"),
  );
});

test("repoLabelFromNormalized: takes the last two path segments", () => {
  assert.equal(repoLabelFromNormalized("github.com/owner/repo"), "owner/repo");
  assert.equal(repoLabelFromNormalized("gitlab.com/group/subgroup/repo"), "subgroup/repo");
  assert.equal(repoLabelFromNormalized(""), "");
});

// ── deriveRepoIdentity ──────────────────────────────────────────────────────

test("deriveRepoIdentity: origin present → synced key from normalised URL", async () => {
  const id = await deriveRepoIdentity("/tmp/whatever", originUrl("git@github.com:owner/repo.git"));
  assert.equal(id.synced, true);
  assert.match(id.repo_key, /^[0-9a-f]{16}$/);
  assert.equal(id.repo_label, "owner/repo");
  // identical to the https clone of the same repo
  const httpsId = await deriveRepoIdentity(
    "/tmp/whatever",
    originUrl("https://github.com/owner/repo"),
  );
  assert.equal(id.repo_key, httpsId.repo_key);
});

test("deriveRepoIdentity: no origin remote → local:<basename> fallback (not synced)", async () => {
  const git = fakeGit((args) =>
    args.join(" ") === "remote get-url origin"
      ? { code: 1, stderr: "error: No such remote 'origin'" }
      : undefined,
  ).runner;
  const id = await deriveRepoIdentity("/Users/me/src/MyProject", git);
  assert.equal(id.synced, false);
  assert.equal(id.repo_key, "local:MyProject");
  assert.equal(id.repo_label, "MyProject");
});

test("deriveRepoIdentity: git missing / not a repo (non-zero) → local fallback", async () => {
  const git: GitRunner = async () => ({ code: 127, stdout: "", stderr: "git: not found" });
  const id = await deriveRepoIdentity("/Users/me/src/Thing", git);
  assert.equal(id.synced, false);
  assert.equal(id.repo_key, "local:Thing");
});

test("deriveRepoIdentity: origin set to an empty URL → local fallback", async () => {
  const id = await deriveRepoIdentity("/Users/me/src/Empty", originUrl("   "));
  assert.equal(id.synced, false);
  assert.equal(id.repo_key, "local:Empty");
});

test("deriveRepoIdentity: queries exactly `git remote get-url origin`", async () => {
  const { runner, calls } = fakeGit((args) =>
    args.join(" ") === "remote get-url origin" ? { stdout: "https://github.com/o/r.git\n" } : undefined,
  );
  await deriveRepoIdentity("/tmp/x", runner);
  assert.deepEqual(calls[0], ["remote", "get-url", "origin"]);
});
