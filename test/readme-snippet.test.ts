import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// dist/test/readme-snippet.test.js -> package root is two levels up.
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(resolve(pkgRoot, rel), "utf8");

test("Ralph/Homer snippet ships as a shell file with both loop kinds", () => {
  const snippet = read("snippets/ralph-homer.sh");
  assert.match(snippet, /--kind loop_completed/);
  assert.match(snippet, /--kind loop_halted/);
  // fire-and-forget: both sends must be non-blocking.
  const sendLines = snippet
    .split("\n")
    .filter((l) => l.includes("gocode-notify send"));
  assert.equal(sendLines.length, 2, "exactly two send lines");
  for (const l of sendLines) {
    assert.ok(l.includes("--source ralph"), `source tag on: ${l}`);
  }
  // The halt line continues onto the next line; assert `|| true` guards both
  // commands (count only executable lines — comments mention it too).
  const guards = snippet
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#") && l.includes("|| true"));
  assert.equal(guards.length, 2, "both commands fire-and-forget guarded");
  // Opt-in, never auto-injected — make that explicit in the file.
  assert.match(snippet, /OPT-IN/i);
});

test("snippets/ dir is in the package `files` allowlist", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(
    (pkg.files ?? []).includes("snippets"),
    "package.json files must include 'snippets' so the snippet ships",
  );
});

test("README documents both install paths", () => {
  const readme = read("README.md");
  // Path 1 — terminal one-liner.
  assert.match(readme, /npx @trygocode\/notify@latest setup/);
  // Path 2 — agent-driven prompt.
  assert.match(readme, /--agent-driven --pair-code/);
  // README must reference the test push verification step (Path 2 prompt).
  assert.match(readme, /@latest test/);
});

test("README documents the Ralph/Homer opt-in snippet", () => {
  const readme = read("README.md");
  assert.match(readme, /loop_completed/);
  assert.match(readme, /loop_halted/);
  assert.match(readme, /snippets\/ralph-homer\.sh/);
  // Must state it is opt-in / not auto-injected.
  assert.match(readme, /opt-in/i);
  assert.match(readme, /never auto-injected/i);
});
