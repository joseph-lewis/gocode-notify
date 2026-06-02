// Tests for the DETERMINISTIC commit-message fallback (PRD §2.3, task T-C1).
// These pin the pure-function contract: no network, no git, no clock — just a
// staged diff/stat fixture in, a deterministic message string out. The AI
// resolution chain (T-C2) is layered on top of these and tested separately.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDeterministicMessage,
  composeCommitMessage,
  defaultCommandExists,
  inferCommitType,
  parseNumstat,
  resolveSummariserCommand,
  sanitiseAiMessage,
  truncateDiff,
  COMMIT_PROMPT,
  SUBJECT_MAX,
  type ComposeCommitMessageInput,
  type FileStat,
  type SummariserInvocation,
} from "../src/commit_message.js";

// ── parseNumstat ───────────────────────────────────────────────────────────

test("parseNumstat parses tab-separated added/deleted/path records", () => {
  const numstat = "12\t5\tsrc/push.ts\n3\t1\tdocs/notes.md";
  assert.deepEqual(parseNumstat(numstat), [
    { path: "src/push.ts", added: 12, deleted: 5 },
    { path: "docs/notes.md", added: 3, deleted: 1 },
  ]);
});

test("parseNumstat marks binary files (git reports '-' counts) as +0 -0 binary", () => {
  const [stat] = parseNumstat("-\t-\tassets/logo.png");
  assert.deepEqual(stat, { path: "assets/logo.png", added: 0, deleted: 0, binary: true });
});

test("parseNumstat skips blank/malformed lines and tolerates CRLF + trailing newline", () => {
  const numstat = "\r\n7\t0\tsrc/a.ts\r\ngarbage line without tabs\n\n0\t0\tsrc/b.ts\n";
  assert.deepEqual(parseNumstat(numstat), [
    { path: "src/a.ts", added: 7, deleted: 0 },
    { path: "src/b.ts", added: 0, deleted: 0 },
  ]);
});

test("parseNumstat preserves rename records verbatim in the path", () => {
  const [stat] = parseNumstat("4\t2\tsrc/{old.ts => new.ts}");
  assert.equal(stat.path, "src/{old.ts => new.ts}");
});

test("parseNumstat returns [] for empty input", () => {
  assert.deepEqual(parseNumstat(""), []);
  assert.deepEqual(parseNumstat("\n\n  \n"), []);
});

// ── inferCommitType ────────────────────────────────────────────────────────

test("inferCommitType → docs when every path is markdown", () => {
  assert.equal(inferCommitType(["docs/a.md", "docs/sub/b.mdx", "README.md"]), "docs");
});

test("inferCommitType → test when every path is a test dir or .test/.spec file", () => {
  assert.equal(inferCommitType(["test/foo.test.ts", "tests/bar.ts", "src/x.spec.ts"]), "test");
  assert.equal(inferCommitType(["pkg/__tests__/baz.js"]), "test");
});

test("inferCommitType → chore for lockfiles / known config / dotfiles", () => {
  assert.equal(inferCommitType(["package-lock.json", "tsconfig.json", ".gitignore"]), "chore");
  assert.equal(inferCommitType(["pnpm-lock.yaml"]), "chore");
  assert.equal(inferCommitType(["vite.config.ts"]), "chore");
});

test("inferCommitType → feat for source code and for ANY mixed changeset", () => {
  assert.equal(inferCommitType(["src/push.ts"]), "feat");
  // A source file + its markdown doc + its test is a real change → feat, not docs/test.
  assert.equal(inferCommitType(["src/push.ts", "docs/push.md", "test/push.test.ts"]), "feat");
});

test("inferCommitType → feat for an empty changeset (safe default)", () => {
  assert.equal(inferCommitType([]), "feat");
});

// ── buildDeterministicMessage ──────────────────────────────────────────────

test("buildDeterministicMessage renders the full §2.3 template", () => {
  const files: FileStat[] = [
    { path: "src/push.ts", added: 40, deleted: 2 },
    { path: "src/commit_message.ts", added: 120, deleted: 0 },
  ];
  const msg = buildDeterministicMessage({ files, branch: "dev", source: "cursor" });
  assert.equal(
    msg,
    "feat: 2 files changed on dev\n\n" +
      "src/push.ts | +40 -2\n" +
      "src/commit_message.ts | +120 -0\n\n" +
      "Auto-committed by GoCode Notify (source: cursor).",
  );
});

test("buildDeterministicMessage uses the singular 'file' for exactly one change", () => {
  const msg = buildDeterministicMessage({
    files: [{ path: "docs/readme.md", added: 1, deleted: 0 }],
    branch: "main",
    source: "claude_code",
  });
  assert.match(msg, /^docs: 1 file changed on main\n/);
  assert.match(msg, /Auto-committed by GoCode Notify \(source: claude_code\)\.$/);
});

test("buildDeterministicMessage collapses the stat block to 10 lines + '...and M more'", () => {
  const files: FileStat[] = Array.from({ length: 13 }, (_, i) => ({
    path: `src/file${i}.ts`,
    added: i,
    deleted: 0,
  }));
  const msg = buildDeterministicMessage({ files, branch: "feature/x", source: "opencode" });
  const lines = msg.split("\n");
  // subject, blank, 10 stat lines, "...and 3 more", blank, footer.
  assert.equal(lines[0], "feat: 13 files changed on feature/x");
  const statLines = lines.filter((l) => l.includes(" | +"));
  assert.equal(statLines.length, 10);
  assert.match(msg, /\n\.\.\.and 3 more\n/);
});

test("buildDeterministicMessage renders binary files as '| bin'", () => {
  const msg = buildDeterministicMessage({
    files: [{ path: "assets/logo.png", added: 0, deleted: 0, binary: true }],
    branch: "dev",
    source: "cursor",
  });
  assert.match(msg, /^feat: 1 file changed on dev\n\nassets\/logo\.png \| bin\n/);
});

test("buildDeterministicMessage is total on an empty changeset (no stray blank line)", () => {
  const msg = buildDeterministicMessage({ files: [], branch: "dev", source: "cursor" });
  assert.equal(
    msg,
    "feat: 0 files changed on dev\n\nAuto-committed by GoCode Notify (source: cursor).",
  );
});

test("buildDeterministicMessage composes with parseNumstat end-to-end", () => {
  const numstat = "5\t1\tdocs/a.md\n2\t0\tdocs/b.md";
  const msg = buildDeterministicMessage({
    files: parseNumstat(numstat),
    branch: "docs-update",
    source: "cursor",
  });
  assert.match(msg, /^docs: 2 files changed on docs-update\n/);
  assert.match(msg, /docs\/a\.md \| \+5 -1/);
});

test("buildDeterministicMessage is deterministic (same input → same output)", () => {
  const input = {
    files: [{ path: "src/x.ts", added: 1, deleted: 1 }],
    branch: "dev",
    source: "cursor",
  };
  assert.equal(buildDeterministicMessage(input), buildDeterministicMessage(input));
});

// ── sanitiseAiMessage (T-C2) ───────────────────────────────────────────────

test("sanitiseAiMessage strips a wrapping ```code fence```", () => {
  const raw = "```\nfeat: add widget\n\nbody line\n```";
  assert.equal(sanitiseAiMessage(raw), "feat: add widget\n\nbody line");
});

test("sanitiseAiMessage strips a ```language fence and inner fences", () => {
  const raw = "```text\nfix: handle null branch\n```";
  assert.equal(sanitiseAiMessage(raw), "fix: handle null branch");
});

test("sanitiseAiMessage drops a leading 'Here is…' preamble line", () => {
  assert.equal(
    sanitiseAiMessage("Here is the commit message:\n\nfeat: add push gate"),
    "feat: add push gate",
  );
  assert.equal(sanitiseAiMessage("Sure! feat: tidy up\n"), "feat: tidy up");
});

test("sanitiseAiMessage strips an inline 'Commit message:' subject prefix", () => {
  assert.equal(sanitiseAiMessage("Commit message: chore: bump deps"), "chore: bump deps");
});

test("sanitiseAiMessage clamps the subject to SUBJECT_MAX chars", () => {
  const longSubject = "feat: " + "x".repeat(120);
  const out = sanitiseAiMessage(longSubject);
  const subject = out.split("\n")[0];
  assert.equal(subject.length, SUBJECT_MAX);
  assert.ok(longSubject.startsWith(subject));
});

test("sanitiseAiMessage returns '' for empty/whitespace/fence-only garbage", () => {
  assert.equal(sanitiseAiMessage(""), "");
  assert.equal(sanitiseAiMessage("   \n\n  "), "");
  assert.equal(sanitiseAiMessage("```\n```"), "");
});

// ── truncateDiff (T-C2) ────────────────────────────────────────────────────

test("truncateDiff passes through diffs within the byte cap", () => {
  const diff = "a".repeat(100);
  assert.equal(truncateDiff(diff, 200), diff);
});

test("truncateDiff cuts over-cap diffs and appends a marker", () => {
  const out = truncateDiff("b".repeat(500), 50);
  assert.ok(out.startsWith("b".repeat(50)));
  assert.match(out, /\[diff truncated at 50 bytes\]$/);
});

// ── resolveSummariserCommand (T-C2) ────────────────────────────────────────

test("resolveSummariserCommand: explicit settings.command wins over auto-detect", () => {
  const cmd = resolveSummariserCommand(
    { command: "ollama run llama3.2" },
    "claude_code",
    () => true, // even though claude is "on PATH", explicit wins
  );
  assert.equal(cmd, "ollama run llama3.2");
});

test("resolveSummariserCommand: auto-detect claude for claude_code source", () => {
  assert.equal(
    resolveSummariserCommand({}, "claude_code", (b) => b === "claude"),
    "claude -p",
  );
});

test("resolveSummariserCommand: auto-detect cursor-agent for cursor source", () => {
  assert.equal(
    resolveSummariserCommand({}, "cursor", (b) => b === "cursor-agent"),
    "cursor-agent --print",
  );
});

test("resolveSummariserCommand: falls back to ollama when present", () => {
  assert.equal(
    resolveSummariserCommand({}, "opencode", (b) => b === "ollama"),
    "ollama run llama3.2",
  );
});

test("resolveSummariserCommand: null when nothing is configured or on PATH", () => {
  assert.equal(resolveSummariserCommand({}, "cursor", () => false), null);
  assert.equal(resolveSummariserCommand({ command: "   " }, "cursor", () => false), null);
});

// ── composeCommitMessage (T-C2) ────────────────────────────────────────────

const FILES: FileStat[] = [{ path: "src/push.ts", added: 10, deleted: 1 }];

function baseInput(over: Partial<ComposeCommitMessageInput> = {}): ComposeCommitMessageInput {
  return {
    files: FILES,
    stagedDiff: "diff --git a/src/push.ts b/src/push.ts\n+pushed",
    statSummary: " src/push.ts | 11 +++++++++++",
    branch: "dev",
    source: "cursor",
    ...over,
  };
}

test("composeCommitMessage: mode=deterministic skips AI entirely", async () => {
  let called = false;
  const res = await composeCommitMessage(baseInput({ settings: { mode: "deterministic" } }), {
    runSummariser: async () => {
      called = true;
      return "feat: should never run";
    },
    commandExists: () => true,
  });
  assert.equal(called, false);
  assert.equal(res.generator, "deterministic");
  assert.match(res.message, /^feat: 1 file changed on dev\n/);
});

test("composeCommitMessage: uses a clean AI summary (sanitised) when available", async () => {
  const res = await composeCommitMessage(baseInput({ settings: { command: "fake-ai" } }), {
    runSummariser: async () => "```\nfeat: wire push-on-stop gate\n```",
    commandExists: () => true,
  });
  assert.equal(res.generator, "ai");
  assert.equal(res.message, "feat: wire push-on-stop gate");
});

test("composeCommitMessage: the fake summariser receives prompt + stat + diff on stdin", async () => {
  let seen: SummariserInvocation | null = null;
  await composeCommitMessage(baseInput({ settings: { command: "fake-ai" } }), {
    runSummariser: async (inv) => {
      seen = inv;
      return "feat: ok";
    },
    commandExists: () => true,
  });
  const inv = seen as SummariserInvocation | null;
  assert.ok(inv);
  assert.equal(inv!.command, "fake-ai");
  assert.ok(inv!.input.startsWith(COMMIT_PROMPT));
  assert.match(inv!.input, /src\/push\.ts \| 11/);
  assert.match(inv!.input, /diff --git a\/src\/push\.ts/);
});

test("composeCommitMessage: max_diff_bytes truncates the diff sent to the summariser", async () => {
  let seen: SummariserInvocation | null = null;
  const bigDiff = "z".repeat(5000);
  await composeCommitMessage(
    baseInput({ stagedDiff: bigDiff, settings: { command: "fake-ai", max_diff_bytes: 100 } }),
    {
      runSummariser: async (inv) => {
        seen = inv;
        return "feat: ok";
      },
      commandExists: () => true,
    },
  );
  const inv = seen as SummariserInvocation | null;
  assert.ok(inv);
  assert.match(inv!.input, /\[diff truncated at 100 bytes\]/);
});

test("composeCommitMessage: runner error falls back to deterministic", async () => {
  const res = await composeCommitMessage(baseInput({ settings: { command: "fake-ai" } }), {
    runSummariser: async () => {
      throw new Error("boom");
    },
    commandExists: () => true,
  });
  assert.equal(res.generator, "deterministic");
  assert.match(res.message, /^feat: 1 file changed on dev\n/);
});

test("composeCommitMessage: empty/garbage AI output falls back to deterministic", async () => {
  const res = await composeCommitMessage(baseInput({ settings: { command: "fake-ai" } }), {
    runSummariser: async () => "```\n```",
    commandExists: () => true,
  });
  assert.equal(res.generator, "deterministic");
});

test("composeCommitMessage: no resolvable command falls back to deterministic", async () => {
  let called = false;
  const res = await composeCommitMessage(baseInput(), {
    runSummariser: async () => {
      called = true;
      return "feat: nope";
    },
    commandExists: () => false, // nothing on PATH, no explicit command
  });
  assert.equal(called, false);
  assert.equal(res.generator, "deterministic");
});

test("composeCommitMessage: the 8s hard cap aborts a hung summariser → fallback", async () => {
  const res = await composeCommitMessage(baseInput({ settings: { command: "fake-ai" } }), {
    timeoutMs: 20,
    commandExists: () => true,
    // A runner that only settles when the abort signal fires (i.e. never on its own).
    runSummariser: ({ signal }) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  assert.equal(res.generator, "deterministic");
  assert.match(res.message, /^feat: 1 file changed on dev\n/);
});

test("composeCommitMessage never rejects (total over all inputs)", async () => {
  const res = await composeCommitMessage(
    baseInput({ files: [], settings: { mode: "deterministic" } }),
  );
  assert.equal(res.generator, "deterministic");
  assert.match(res.message, /^feat: 0 files changed on dev\n/);
});

// ── defaultCommandExists (T-C2) ────────────────────────────────────────────

test("defaultCommandExists finds a known PATH binary and rejects a bogus one", () => {
  // `node` is necessarily on PATH here (the test runner is node). A random name
  // with no path separator must not resolve.
  assert.equal(defaultCommandExists("node"), true);
  assert.equal(defaultCommandExists("definitely-not-a-real-binary-xyz123"), false);
});
