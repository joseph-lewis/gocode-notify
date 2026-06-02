// Tests for canonical runtime detection (PRD §5.2): detect Claude Code / Cursor
// / OpenCode by config dir OR (for Claude Code) `claude` on $PATH. Every case
// runs against a fresh fixture HOME and an INJECTED $PATH so detection is fully
// deterministic — no reliance on the machine's real ~/.claude etc. or whatever
// binaries happen to be installed on the test runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectRuntimes,
  detectRuntime,
  RUNTIMES,
  type RuntimeStatus,
} from "../src/detect.js";

/** Fresh empty temp HOME. */
async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "gocode-detect-"));
}

/** mkdir -p `<home>/<rel>`. */
async function mkrel(home: string, rel: string): Promise<void> {
  await fs.mkdir(path.join(home, rel), { recursive: true });
}

/** Create an empty file at `<home>/<rel>` (parents made as needed). */
async function touch(home: string, rel: string): Promise<void> {
  const p = path.join(home, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, "");
}

const byName = (rs: RuntimeStatus[], n: string): RuntimeStatus =>
  rs.find((r) => r.name === n)!;

// An empty injected PATH so the real environment's `claude` (if any) never leaks
// into a detection that's supposed to be testing the config-dir branch.
const NO_PATH = { path: "" };

test("RUNTIMES is the three documented runtimes, Claude-first (PRD §5.2)", () => {
  assert.deepEqual(RUNTIMES.map((r) => r.name), ["Claude Code", "Cursor", "OpenCode"]);
  // Only Claude Code declares a PATH command.
  const claude = RUNTIMES.find((r) => r.name === "Claude Code")!;
  assert.deepEqual(claude.pathCommands, ["claude"]);
  assert.equal(RUNTIMES.find((r) => r.name === "Cursor")!.pathCommands, undefined);
});

test("nothing detected in an empty HOME with an empty PATH", async () => {
  const home = await tempHome();
  const rs = await detectRuntimes({ home, ...NO_PATH });
  assert.equal(rs.length, 3);
  for (const r of rs) {
    assert.equal(r.detected, false, `${r.name} must be undetected in a clean HOME`);
    assert.equal(r.configWritten, false);
  }
});

test("Claude Code detected by ~/.claude dir (config path + configWritten)", async () => {
  const home = await tempHome();
  await mkrel(home, ".claude");
  const rs = await detectRuntimes({ home, ...NO_PATH });
  const c = byName(rs, "Claude Code");
  assert.equal(c.detected, true);
  assert.equal(c.configWritten, false, "dir exists but settings.json not written yet");
  assert.equal(c.configPath, path.join(home, ".claude", "settings.json"));
  // The others stay undetected.
  assert.equal(byName(rs, "Cursor").detected, false);
  assert.equal(byName(rs, "OpenCode").detected, false);
});

test("Claude Code detected by `claude` on PATH even without ~/.claude (PRD §5.2)", async () => {
  const home = await tempHome();
  // A fixture PATH dir containing an (empty) `claude` executable file.
  const bin = path.join(home, "fakebin");
  await touch(home, path.join("fakebin", "claude"));
  const rs = await detectRuntimes({ home, path: bin });
  const c = byName(rs, "Claude Code");
  assert.equal(c.detected, true, "claude on PATH satisfies detection");
  // Config path still anchors at the primary detect-dir even though it's absent.
  assert.equal(c.configPath, path.join(home, ".claude", "settings.json"));
  assert.equal(c.configWritten, false, "detected via PATH but no config dir → not written");
});

test("Cursor is NOT detected by a `claude` on PATH (PATH commands are per-runtime)", async () => {
  const home = await tempHome();
  const bin = path.join(home, "fakebin");
  await touch(home, path.join("fakebin", "claude"));
  const rs = await detectRuntimes({ home, path: bin });
  assert.equal(byName(rs, "Cursor").detected, false);
  assert.equal(byName(rs, "OpenCode").detected, false);
});

test("configWritten flips true once the runtime's config file exists", async () => {
  const home = await tempHome();
  await mkrel(home, ".cursor");
  let rs = await detectRuntimes({ home, ...NO_PATH });
  assert.equal(byName(rs, "Cursor").configWritten, false);

  await touch(home, path.join(".cursor", "hooks.json"));
  rs = await detectRuntimes({ home, ...NO_PATH });
  const cur = byName(rs, "Cursor");
  assert.equal(cur.detected, true);
  assert.equal(cur.configWritten, true);
});

test("OpenCode detected via ~/.config/opencode (the primary detect dir)", async () => {
  const home = await tempHome();
  await mkrel(home, ".config/opencode");
  const oc = byName(await detectRuntimes({ home, ...NO_PATH }), "OpenCode");
  assert.equal(oc.detected, true);
  assert.equal(oc.configPath, path.join(home, ".config/opencode", "mcp.json"));
});

test("OpenCode detected via the fallback ~/.opencode dir", async () => {
  const home = await tempHome();
  await mkrel(home, ".opencode");
  const oc = byName(await detectRuntimes({ home, ...NO_PATH }), "OpenCode");
  assert.equal(oc.detected, true);
  // configPath anchors at the dir that actually exists.
  assert.equal(oc.configPath, path.join(home, ".opencode", "mcp.json"));
});

test("the first existing detect-dir wins for the config path", async () => {
  const home = await tempHome();
  // Create BOTH OpenCode dirs; the primary (.config/opencode) is first in the
  // spec so it should anchor the config path.
  await mkrel(home, ".config/opencode");
  await mkrel(home, ".opencode");
  const oc = byName(await detectRuntimes({ home, ...NO_PATH }), "OpenCode");
  assert.equal(oc.configPath, path.join(home, ".config/opencode", "mcp.json"));
});

test("detectRuntime works on a single spec and never throws on a missing HOME", async () => {
  const spec = RUNTIMES.find((r) => r.name === "Claude Code")!;
  // Point at a HOME path that does not exist — detection must resolve, not throw.
  const r = await detectRuntime(spec, { home: "/no/such/home/xyz", path: "" });
  assert.equal(r.detected, false);
  assert.equal(r.configWritten, false);
});

test("an empty PATH segment is ignored (no false positive from a leading delimiter)", async () => {
  const home = await tempHome();
  // PATH with an empty leading entry + a real dir holding `claude`.
  const bin = path.join(home, "realbin");
  await touch(home, path.join("realbin", "claude"));
  const rs = await detectRuntimes({ home, path: `${path.delimiter}${bin}` });
  assert.equal(byName(rs, "Claude Code").detected, true);
});

test("a PATH dir WITHOUT `claude` leaves Claude Code undetected", async () => {
  const home = await tempHome();
  const bin = path.join(home, "emptybin");
  await mkrel(home, "emptybin"); // exists but holds no `claude`
  const rs = await detectRuntimes({ home, path: bin });
  assert.equal(byName(rs, "Claude Code").detected, false);
});
