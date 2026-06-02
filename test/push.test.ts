import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushOnStop,
  isProtectedBranch,
  isNonFastForward,
  type GitResult,
  type GitRunner,
  type PushOnStopOptions,
} from "../src/push.js";
import type { SendPayload, SendResult } from "../src/send.js";
import type { ComposeResult } from "../src/commit_message.js";

// ── test doubles ────────────────────────────────────────────────────────────

/** A fake git runner that records every invocation and routes by argv. */
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

/** A recording stub for `send`. */
function fakeSend(result: Partial<SendResult> = {}): {
  fn: (p: SendPayload) => Promise<SendResult>;
  calls: SendPayload[];
} {
  const calls: SendPayload[] = [];
  const fn = async (p: SendPayload): Promise<SendResult> => {
    calls.push(p);
    return { ok: result.ok ?? true, status: result.status ?? 200, sent: result.sent ?? 1 };
  };
  return { fn, calls };
}

/** A controllable compose stub (avoids any AI subprocess in the push tests). */
function fakeCompose(
  message = "feat: do a thing",
  generator: ComposeResult["generator"] = "deterministic",
) {
  const calls: unknown[] = [];
  const fn = async (input: unknown): Promise<ComposeResult> => {
    calls.push(input);
    return { message, generator };
  };
  return { fn, calls };
}

/** Routes the common "healthy repo on a feature branch" git replies. */
function healthyRepo(over: Record<string, Partial<GitResult>> = {}): (args: string[]) => Partial<GitResult> {
  return (args) => {
    const key = args.join(" ");
    if (over[key]) return over[key];
    if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
    if (key === "rev-parse --abbrev-ref HEAD") return { stdout: "feature/x\n" };
    if (key === "diff --staged --numstat") return { stdout: "3\t1\tsrc/a.ts\n0\t2\tsrc/b.ts\n" };
    if (key === "diff --staged") return { stdout: "diff --git a/src/a.ts b/src/a.ts\n+...\n" };
    if (key === "diff --staged --stat") return { stdout: " src/a.ts | 4 ++--\n" };
    if (key === "rev-parse --short HEAD") return { stdout: "abc1234\n" };
    if (key.startsWith("push ")) return { code: 0 };
    if (args[0] === "add") return { code: 0 };
    if (args[0] === "commit") return { code: 0 };
    return {};
  };
}

/** Captured-tempfile writer so commit `-F` is testable without touching the fs. */
function fakeCommitFile() {
  const written: { message: string; path: string }[] = [];
  return {
    write: async (message: string): Promise<string> => {
      const p = `/tmp/fake-commit-${written.length}.txt`;
      written.push({ message, path: p });
      return p;
    },
    remove: async (): Promise<void> => {},
    written,
  };
}

/** Common injected deps so tests don't hit fs/network/subprocess. */
function baseOpts(git: GitRunner, extra: Partial<PushOnStopOptions> = {}): PushOnStopOptions {
  const cf = fakeCommitFile();
  return {
    git,
    sendImpl: fakeSend().fn,
    compose: fakeCompose().fn,
    writeCommitFile: cf.write,
    removeCommitFile: cf.remove,
    log: () => {},
    source: "cursor",
    settings: { auto_push: { enabled: true } },
    ...extra,
  };
}

/** Assert NO git invocation ever requested a force-push. */
function assertNeverForced(calls: string[][]): void {
  for (const c of calls) {
    assert.ok(!c.includes("--force"), `git invoked with --force: ${c.join(" ")}`);
    assert.ok(!c.includes("-f"), `git invoked with -f: ${c.join(" ")}`);
    assert.ok(
      !c.some((a) => a.startsWith("--force")),
      `git invoked with a --force* flag: ${c.join(" ")}`,
    );
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

test("isProtectedBranch flags main/master and nothing else", () => {
  assert.equal(isProtectedBranch("main"), true);
  assert.equal(isProtectedBranch("master"), true);
  assert.equal(isProtectedBranch(" main "), true); // trims
  assert.equal(isProtectedBranch("develop"), false);
  assert.equal(isProtectedBranch("feature/x"), false);
});

test("isNonFastForward recognises git's rejection wording", () => {
  assert.equal(isNonFastForward("! [rejected] main -> main (non-fast-forward)"), true);
  assert.equal(isNonFastForward("Updates were rejected because the tip of your current branch is behind"), true);
  assert.equal(isNonFastForward("hint: fetch first"), true);
  assert.equal(isNonFastForward("everything up-to-date"), false);
});

// ── gate-off / fail-safe ────────────────────────────────────────────────────

test("gate-off: auto_push.enabled !== true is a no-op (no git, no send)", async () => {
  const git = fakeGit(healthyRepo());
  const send = fakeSend();
  const res = await pushOnStop(
    baseOpts(git.runner, { sendImpl: send.fn, settings: { auto_push: { enabled: false } } }),
  );
  assert.equal(res.outcome, "disabled");
  assert.equal(git.calls.length, 0, "no git commands when gated off");
  assert.equal(send.calls.length, 0, "no notification when gated off");
});

test("fail-safe: absent settings → treated as OFF (no git, no send)", async () => {
  const git = fakeGit(healthyRepo());
  const send = fakeSend();
  const res = await pushOnStop({ git: git.runner, sendImpl: send.fn, compose: fakeCompose().fn, log: () => {} });
  assert.equal(res.outcome, "disabled");
  assert.equal(git.calls.length, 0);
  assert.equal(send.calls.length, 0);
});

// ── not-a-repo ───────────────────────────────────────────────────────────────

test("not-a-repo: rev-parse fails → no-op, no send", async () => {
  const git = fakeGit((args) =>
    args.join(" ") === "rev-parse --is-inside-work-tree" ? { code: 128, stderr: "not a git repository" } : {},
  );
  const send = fakeSend();
  const res = await pushOnStop(baseOpts(git.runner, { sendImpl: send.fn }));
  assert.equal(res.outcome, "not-a-repo");
  assert.equal(send.calls.length, 0);
  // never staged / committed / pushed
  assert.ok(!git.calls.some((c) => c[0] === "add" || c[0] === "commit" || c[0] === "push"));
});

// ── clean tree ───────────────────────────────────────────────────────────────

test("clean-tree: nothing staged → no commit, no push, no notification", async () => {
  const git = fakeGit(healthyRepo({ "diff --staged --numstat": { stdout: "\n" } }));
  const send = fakeSend();
  const res = await pushOnStop(baseOpts(git.runner, { sendImpl: send.fn }));
  assert.equal(res.outcome, "clean-tree");
  assert.equal(res.branch, "feature/x");
  assert.ok(git.calls.some((c) => c[0] === "add"), "did stage (add -A)");
  assert.ok(!git.calls.some((c) => c[0] === "commit"), "did NOT commit a clean tree");
  assert.ok(!git.calls.some((c) => c[0] === "push"), "did NOT push a clean tree");
  assert.equal(send.calls.length, 0, "no spurious notification on a clean tree");
});

// ── branch guard ─────────────────────────────────────────────────────────────

test("branch guard: protected branch + guard on → skip, no push, no send", async () => {
  const git = fakeGit(healthyRepo({ "rev-parse --abbrev-ref HEAD": { stdout: "main\n" } }));
  const send = fakeSend();
  const res = await pushOnStop(baseOpts(git.runner, { sendImpl: send.fn }));
  assert.equal(res.outcome, "protected-branch-skipped");
  assert.equal(res.branch, "main");
  assert.ok(!git.calls.some((c) => c[0] === "add"), "guard skips BEFORE staging");
  assert.ok(!git.calls.some((c) => c[0] === "push"));
  assert.equal(send.calls.length, 0);
});

test("branch guard: protected branch + allow_protected true → proceeds to push", async () => {
  const git = fakeGit(healthyRepo({ "rev-parse --abbrev-ref HEAD": { stdout: "main\n" } }));
  const send = fakeSend();
  const res = await pushOnStop(
    baseOpts(git.runner, {
      sendImpl: send.fn,
      settings: { auto_push: { enabled: true, allow_protected: true } },
    }),
  );
  assert.equal(res.outcome, "pushed");
  assert.equal(res.branch, "main");
  assert.ok(git.calls.some((c) => c[0] === "push" && c[2] === "main"));
  assert.equal(send.calls[0]?.kind, "finished");
});

// ── happy path FF push ───────────────────────────────────────────────────────

test("FF push: stages, commits via -F tempfile, pushes, sends ONE finished", async () => {
  const git = fakeGit(healthyRepo());
  const send = fakeSend();
  const compose = fakeCompose("feat: add widget\n\nbody line", "ai");
  const cf = fakeCommitFile();
  const res = await pushOnStop(
    baseOpts(git.runner, {
      sendImpl: send.fn,
      compose: compose.fn,
      writeCommitFile: cf.write,
      removeCommitFile: cf.remove,
      project: "owner/repo",
      dedupeKey: "cursor-stop",
    }),
  );

  assert.equal(res.outcome, "pushed");
  assert.equal(res.branch, "feature/x");
  assert.equal(res.sha, "abc1234");
  assert.equal(res.generator, "ai");
  assert.equal(res.notified, true);

  // commit used -F with the composed message written to a tempfile
  const commit = git.calls.find((c) => c[0] === "commit");
  assert.ok(commit, "committed");
  assert.equal(commit?.[1], "-F");
  assert.equal(commit?.[2], cf.written[0]?.path);
  assert.equal(cf.written[0]?.message, "feat: add widget\n\nbody line");

  // pushed to origin feature/x (FF — plain push, no force)
  const push = git.calls.find((c) => c[0] === "push");
  assert.deepEqual(push, ["push", "origin", "feature/x"]);

  // exactly ONE finished notification carrying the subject + branch + sha
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].kind, "finished");
  assert.equal(send.calls[0].source, "cursor");
  assert.equal(send.calls[0].project, "owner/repo");
  assert.equal(send.calls[0].dedupe_key, "cursor-stop");
  assert.match(send.calls[0].body ?? "", /feat: add widget/);
  assert.match(send.calls[0].body ?? "", /feature\/x @ abc1234/);

  assertNeverForced(git.calls);
});

test("custom remote from settings is honoured on push", async () => {
  const git = fakeGit(healthyRepo());
  const res = await pushOnStop(
    baseOpts(git.runner, { settings: { auto_push: { enabled: true, remote: "upstream" } } }),
  );
  assert.equal(res.outcome, "pushed");
  assert.deepEqual(
    git.calls.find((c) => c[0] === "push"),
    ["push", "upstream", "feature/x"],
  );
});

test("skip_git_hooks adds --no-verify to commit", async () => {
  const git = fakeGit(healthyRepo());
  await pushOnStop(
    baseOpts(git.runner, { settings: { auto_push: { enabled: true, skip_git_hooks: true } } }),
  );
  const commit = git.calls.find((c) => c[0] === "commit");
  assert.ok(commit?.includes("--no-verify"));
});

// ── non-FF rejection ─────────────────────────────────────────────────────────

test("non-FF rejection: error notification, never force, exit-0 outcome", async () => {
  const git = fakeGit(
    healthyRepo({
      "push origin feature/x": {
        code: 1,
        stderr: "! [rejected] feature/x -> feature/x (non-fast-forward)\n",
      },
    }),
  );
  const send = fakeSend();
  const res = await pushOnStop(baseOpts(git.runner, { sendImpl: send.fn }));

  assert.equal(res.outcome, "push-rejected");
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].kind, "error");
  assert.equal(send.calls[0].body, "auto-push rejected (remote moved); pull + retry");

  // a commit DID land (we never roll it back), but we NEVER retried with force
  assert.ok(git.calls.some((c) => c[0] === "commit"));
  const pushes = git.calls.filter((c) => c[0] === "push");
  assert.equal(pushes.length, 1, "exactly one push attempt — no force retry");
  assertNeverForced(git.calls);
});

test("generic push failure (not non-FF) still sends an error + exits 0", async () => {
  const git = fakeGit(
    healthyRepo({
      "push origin feature/x": { code: 128, stderr: "fatal: unable to access remote: timeout\n" },
    }),
  );
  const send = fakeSend();
  const res = await pushOnStop(baseOpts(git.runner, { sendImpl: send.fn }));
  assert.equal(res.outcome, "push-rejected");
  assert.equal(send.calls[0].kind, "error");
  assert.match(send.calls[0].body ?? "", /auto-push failed/);
});

// ── commit failure ───────────────────────────────────────────────────────────

test("commit-failed: a failing commit stops before push, no notification", async () => {
  const healthy = healthyRepo();
  // `commit` runs as `commit -F <tempfile>`, so route by args[0] (not the join).
  const git = fakeGit((args) =>
    args[0] === "commit" ? { code: 1, stderr: "pre-commit hook rejected the change" } : healthy(args),
  );
  const send = fakeSend();
  const res = await pushOnStop(baseOpts(git.runner, { sendImpl: send.fn }));
  assert.equal(res.outcome, "commit-failed");
  assert.ok(!git.calls.some((c) => c[0] === "push"), "did not push after a failed commit");
  assert.equal(send.calls.length, 0);
});

// ── branch resolution (§2.4) ─────────────────────────────────────────────────

test("branch resolution: configured default_branch that exists is used", async () => {
  const git = fakeGit(
    healthyRepo({ "rev-parse --verify --quiet refs/heads/dev": { code: 0, stdout: "deadbeef\n" } }),
  );
  const res = await pushOnStop(
    baseOpts(git.runner, { settings: { auto_push: { enabled: true, default_branch: "dev" } } }),
  );
  assert.equal(res.outcome, "pushed");
  assert.equal(res.branch, "dev");
  assert.deepEqual(git.calls.find((c) => c[0] === "push"), ["push", "origin", "dev"]);
});

test("branch resolution: per-repo override beats global default", async () => {
  const git = fakeGit(
    healthyRepo({ "rev-parse --verify --quiet refs/heads/release": { code: 0 } }),
  );
  const res = await pushOnStop(
    baseOpts(git.runner, {
      settings: { auto_push: { enabled: true, branch: "release", default_branch: "dev" } },
    }),
  );
  assert.equal(res.branch, "release");
});

test("branch resolution: configured branch missing locally → fall back to current", async () => {
  const git = fakeGit(
    healthyRepo({ "rev-parse --verify --quiet refs/heads/dev": { code: 1 } }),
  );
  const res = await pushOnStop(
    baseOpts(git.runner, { settings: { auto_push: { enabled: true, default_branch: "dev" } } }),
  );
  assert.equal(res.outcome, "pushed");
  assert.equal(res.branch, "feature/x", "fell back to the current branch");
  assert.match(res.detail ?? "", /not found locally/);
});

// ── deterministic mode skips the AI-only diff fetches ────────────────────────

test("deterministic mode: does not fetch the full staged diff", async () => {
  const git = fakeGit(healthyRepo());
  await pushOnStop(
    baseOpts(git.runner, {
      compose: fakeCompose().fn,
      settings: {
        auto_push: { enabled: true },
        commit_message: { mode: "deterministic" },
      },
    }),
  );
  // numstat is always fetched (clean-tree check); the plain `diff --staged`
  // (and `--stat`) are only needed for the AI prompt → skipped here.
  assert.ok(git.calls.some((c) => c.join(" ") === "diff --staged --numstat"));
  assert.ok(!git.calls.some((c) => c.join(" ") === "diff --staged"));
  assert.ok(!git.calls.some((c) => c.join(" ") === "diff --staged --stat"));
});

// ── dry-run ──────────────────────────────────────────────────────────────────

test("dry-run: resolves the branch but performs NO git writes and NO send", async () => {
  const git = fakeGit(healthyRepo());
  const send = fakeSend();
  const res = await pushOnStop(baseOpts(git.runner, { sendImpl: send.fn, dryRun: true }));
  assert.equal(res.outcome, "dry-run");
  assert.equal(res.branch, "feature/x");
  assert.ok(!git.calls.some((c) => c[0] === "add" || c[0] === "commit" || c[0] === "push"));
  assert.equal(send.calls.length, 0);
});

// ── total / never-throws ─────────────────────────────────────────────────────

test("a git runner that throws never propagates — flow resolves to a safe no-op", async () => {
  const throwing: GitRunner = async () => {
    throw new Error("boom");
  };
  const send = fakeSend();
  const res = await pushOnStop(baseOpts(throwing, { sendImpl: send.fn }));
  assert.equal(res.outcome, "disabled");
  assert.equal(send.calls.length, 0);
});

// ── integration with the REAL composer (deterministic path, no subprocess) ───

test("integration: real composeCommitMessage produces the deterministic message", async () => {
  const git = fakeGit(healthyRepo());
  const send = fakeSend();
  const res = await pushOnStop({
    git: git.runner,
    sendImpl: send.fn,
    writeCommitFile: fakeCommitFile().write,
    removeCommitFile: async () => {},
    log: () => {},
    source: "claude_code",
    settings: { auto_push: { enabled: true }, commit_message: { mode: "deterministic" } },
  });
  assert.equal(res.outcome, "pushed");
  assert.equal(res.generator, "deterministic");
  // deterministic subject: "<type>: <N> files changed on <branch>"
  assert.match(res.message ?? "", /files changed on feature\/x/);
  assert.match(res.message ?? "", /Auto-committed by GoCode Notify \(source: claude_code\)/);
});
