// Tests for the `uninstall` orchestration (PRD §4.1, §11) and its CLI command.
//
// The per-runtime surgical uninstallers (Claude Code / Cursor) are exhaustively
// covered in claude.test.ts / cursor.test.ts. Here we cover the ORCHESTRATION:
// that `uninstall()` runs every runtime, aggregates removed paths, removes
// EXACTLY our entries end-to-end (no collateral) when BOTH runtimes are
// installed alongside the user's own config, is idempotent, reports ok:false
// when a runtime uninstaller fails, leaves credentials untouched, and that
// `cmdUninstall` renders the right output + exit code in both modes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { uninstall, defaultUninstallers, type RuntimeUninstaller } from "../src/uninstall.js";
import { cmdUninstall } from "../src/cli.js";
import { writeClaudeConfig, claudeSettingsPath, claudeSkillDir, CLAUDE_RUNTIME_NAME } from "../src/claude.js";
import {
  writeCursorConfig,
  cursorHooksPath,
  cursorMcpPath,
  cursorRulePath,
  CURSOR_RUNTIME_NAME,
  MCP_SERVER_NAME,
} from "../src/cursor.js";
import { writeCredentials, credentialsPath } from "../src/creds.js";
import { formatStep, type StepLine } from "../src/agent.js";
import type { RuntimeStatus } from "../src/detect.js";

async function tempHome(): Promise<{ home: string }> {
  return { home: await fs.mkdtemp(path.join(os.tmpdir(), "gocode-uninstall-")) };
}

async function readJson(p: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

const claudeRuntime: RuntimeStatus = {
  name: CLAUDE_RUNTIME_NAME,
  detected: true,
  configPath: "",
  configWritten: false,
};
const cursorRuntime: RuntimeStatus = {
  name: CURSOR_RUNTIME_NAME,
  detected: true,
  configPath: "",
  configWritten: false,
};

/** Install both runtimes' configs into a fresh temp HOME, alongside user config. */
async function installBoth(home: { home: string }): Promise<void> {
  // Seed a user-owned Cursor config we must NOT touch.
  await fs.mkdir(path.dirname(cursorHooksPath(home)), { recursive: true });
  await fs.writeFile(
    cursorHooksPath(home),
    JSON.stringify({ version: 1, hooks: { stop: [{ command: "echo user-stop" }] } }),
  );
  await fs.writeFile(
    cursorMcpPath(home),
    JSON.stringify({ mcpServers: { "user-server": { command: "user-cmd" } } }),
  );
  // Seed a user-owned Claude hook we must NOT touch.
  await fs.mkdir(path.dirname(claudeSettingsPath(home)), { recursive: true });
  await fs.writeFile(
    claudeSettingsPath(home),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo user-pre" }] }] } }),
  );

  await writeClaudeConfig(claudeRuntime, home);
  await writeCursorConfig(cursorRuntime, home);
}

test("uninstall removes EXACTLY our entries across both runtimes — no collateral", async () => {
  const home = await tempHome();
  await installBoth(home);

  const result = await uninstall(home);
  assert.equal(result.ok, true);
  assert.equal(result.runtimes.length, 2, "ran both runtimes");
  assert.deepEqual(
    result.runtimes.map((r) => r.runtime),
    [CLAUDE_RUNTIME_NAME, CURSOR_RUNTIME_NAME],
  );

  // Aggregated removed paths include each runtime's touched files.
  assert.ok(result.removed.includes(claudeSettingsPath(home)));
  assert.ok(result.removed.includes(claudeSkillDir(home)));
  assert.ok(result.removed.includes(cursorHooksPath(home)));
  assert.ok(result.removed.includes(cursorMcpPath(home)));
  assert.ok(result.removed.includes(cursorRulePath(home)));

  // Our skill/rule files are gone.
  assert.equal(await exists(claudeSkillDir(home)), false, "claude skill dir gone");
  assert.equal(await exists(cursorRulePath(home)), false, "cursor rule gone");

  // The user's own config survives untouched (the no-collateral requirement).
  const claude = await readJson(claudeSettingsPath(home));
  assert.equal(claude.hooks.Stop, undefined, "our Stop hook removed");
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, "echo user-pre", "user's Claude hook survives");
  assert.equal(claude.mcpServers, undefined, "our MCP-only object dropped");

  const cursorHooks = await readJson(cursorHooksPath(home));
  assert.equal(cursorHooks.hooks.stop[0].command, "echo user-stop", "user's Cursor stop survives");
  assert.equal(cursorHooks.version, 1, "version preserved");
  const cursorMcp = await readJson(cursorMcpPath(home));
  assert.equal(cursorMcp.mcpServers[MCP_SERVER_NAME], undefined, "our Cursor MCP entry removed");
  assert.deepEqual(cursorMcp.mcpServers["user-server"], { command: "user-cmd" });

  // Final summary step reports the aggregate count and overall ok.
  const summary = result.steps[result.steps.length - 1];
  assert.equal(summary.step, "summary");
  assert.equal(summary.ok, true);
  assert.match(summary.detail, /removed \d+ gocode-notify entr/);
});

test("uninstall does NOT touch credentials", async () => {
  const home = await tempHome();
  await installBoth(home);
  await writeCredentials({ api_key: "gck_x", server: "https://s", user_id: "github:1", label: "L" }, home);

  await uninstall(home);

  assert.ok(await exists(credentialsPath(home)), "credentials left in place");
  const creds = await readJson(credentialsPath(home));
  assert.equal(creds.api_key, "gck_x");
});

test("uninstall is a clean no-op when nothing was installed", async () => {
  const home = await tempHome();
  const result = await uninstall(home);
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, []);
  const summary = result.steps[result.steps.length - 1];
  assert.match(summary.detail, /no gocode-notify entries found/);
});

test("uninstall is idempotent (second run finds nothing left to remove)", async () => {
  const home = await tempHome();
  await installBoth(home);
  await uninstall(home);
  const second = await uninstall(home);
  assert.deepEqual(second.removed, []);
  assert.equal(second.ok, true);
});

test("uninstall reports ok:false when a runtime uninstaller fails", async () => {
  const home = await tempHome();
  const failing: ReadonlyArray<{ runtime: string; run: RuntimeUninstaller }> = [
    { runtime: "Boom", run: async () => ({ removed: [], failed: true, detail: "Boom uninstall failed: nope" }) },
    { runtime: "Fine", run: async () => ({ removed: ["/x"], detail: "removed gocode-notify entries (1 path)" }) },
  ];
  const result = await uninstall({ home: home.home, uninstallers: failing });
  assert.equal(result.ok, false, "a single hard failure flips overall ok");
  assert.equal(result.steps.find((s) => s.step === "uninstall:Boom")?.ok, false);
  assert.equal(result.steps.find((s) => s.step === "uninstall:Fine")?.ok, true);
});

test("defaultUninstallers cover exactly Claude Code + Cursor in order", () => {
  assert.deepEqual(
    defaultUninstallers.map((u) => u.runtime),
    [CLAUDE_RUNTIME_NAME, CURSOR_RUNTIME_NAME],
  );
});

test("cmdUninstall --agent-driven emits one JSON line per step and exits 0", async () => {
  const home = await tempHome();
  await installBoth(home);
  const lines: StepLine[] = [];
  const code = await cmdUninstall(["--agent-driven"], { home: home.home, sink: (l) => lines.push(l) });
  assert.equal(code, 0);
  // Each line round-trips through the canonical serializer (no incidental newlines).
  for (const l of lines) assert.equal(formatStep(l), JSON.stringify({ step: l.step, ok: l.ok, detail: l.detail }));
  assert.ok(lines.some((l) => l.step === `uninstall:${CLAUDE_RUNTIME_NAME}`));
  assert.ok(lines.some((l) => l.step === `uninstall:${CURSOR_RUNTIME_NAME}`));
  assert.equal(lines[lines.length - 1].step, "summary");
});

test("cmdUninstall exits 1 when a runtime uninstaller fails", async () => {
  const home = await tempHome();
  const lines: StepLine[] = [];
  const code = await cmdUninstall(["--agent-driven"], {
    home: home.home,
    uninstallers: [{ runtime: "Boom", run: async () => ({ removed: [], failed: true, detail: "fail" }) }],
    sink: (l) => lines.push(l),
  });
  assert.equal(code, 1);
});
