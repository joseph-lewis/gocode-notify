// Tests for the Cursor config writer (PRD §5.4, §5.5, §11). All run against a
// fresh temp HOME so we never touch the real ~/.cursor. Cover: fresh install
// (stop hook + MCP + rule), MERGE (preserve the user's own entries + version),
// idempotency (re-run does not duplicate), and surgical uninstall (remove
// exactly ours).
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeCursorConfig,
  uninstallCursorConfig,
  cursorHooksPath,
  cursorMcpPath,
  cursorRulePath,
  cursorRulesDir,
  CURSOR_RUNTIME_NAME,
  MCP_SERVER_NAME,
  CURSOR_STOP_COMMAND,
  RULE_CONTENT,
} from "../src/cursor.js";
import { defaultConfigWriter } from "../src/setup.js";
import type { RuntimeStatus } from "../src/detect.js";

async function tempHome(): Promise<{ home: string }> {
  return { home: await fs.mkdtemp(path.join(os.tmpdir(), "gocode-cursor-")) };
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

const cursorRuntime: RuntimeStatus = {
  name: CURSOR_RUNTIME_NAME,
  detected: true,
  configPath: "",
  configWritten: false,
};

/** How many of OUR entries the `stop` array holds. */
function ourStopCount(arr: unknown[]): number {
  return arr.filter(
    (h: any) =>
      typeof h?.command === "string" &&
      h.command.includes("gocode-notify") &&
      h.command.includes("--source cursor"),
  ).length;
}

test("fresh install writes the stop hook, the MCP entry, and the rule", async () => {
  const home = await tempHome();
  const r = await writeCursorConfig(cursorRuntime, home);

  assert.equal(r.runtime, CURSOR_RUNTIME_NAME);
  assert.equal(r.skipped, false);
  assert.notEqual(r.failed, true);
  assert.deepEqual(r.written, [
    cursorHooksPath(home),
    cursorMcpPath(home),
    cursorRulePath(home),
  ]);

  const hooks = await readJson(cursorHooksPath(home));
  assert.equal(hooks.version, 1, "version set to 1 on fresh file");
  assert.ok(Array.isArray(hooks.hooks.stop));
  assert.equal(ourStopCount(hooks.hooks.stop), 1);
  assert.equal(hooks.hooks.stop[0].command, CURSOR_STOP_COMMAND);

  const mcp = await readJson(cursorMcpPath(home));
  assert.deepEqual(mcp.mcpServers[MCP_SERVER_NAME], {
    command: "npx",
    args: ["-y", "@trygocode/notify", "mcp"],
  });

  const rule = await fs.readFile(cursorRulePath(home), "utf8");
  assert.equal(rule, RULE_CONTENT);
  assert.match(rule, /do NOT double-notify/i);
  assert.match(rule, /alwaysApply: false/);
});

test("MERGE preserves the user's existing stop hooks, version, MCP servers, and keys", async () => {
  const home = await tempHome();
  await fs.mkdir(path.dirname(cursorHooksPath(home)), { recursive: true });
  await fs.writeFile(
    cursorHooksPath(home),
    JSON.stringify({
      version: 2,
      hooks: {
        stop: [{ command: "echo user-stop" }],
        beforeShell: [{ command: "echo user-before" }],
      },
    }),
  );
  await fs.writeFile(
    cursorMcpPath(home),
    JSON.stringify({ mcpServers: { "user-server": { command: "user-cmd" } } }),
  );

  await writeCursorConfig(cursorRuntime, home);

  const hooks = await readJson(cursorHooksPath(home));
  assert.equal(hooks.version, 2, "existing version preserved");
  assert.ok(hooks.hooks.beforeShell, "unrelated hook event preserved");
  // stop now has BOTH the user's entry and ours.
  assert.equal(hooks.hooks.stop.length, 2);
  assert.equal(hooks.hooks.stop[0].command, "echo user-stop");
  assert.equal(ourStopCount(hooks.hooks.stop), 1);

  const mcp = await readJson(cursorMcpPath(home));
  assert.deepEqual(mcp.mcpServers["user-server"], { command: "user-cmd" });
  assert.ok(mcp.mcpServers[MCP_SERVER_NAME], "our MCP entry added alongside user's");
});

test("install is idempotent: re-running does not duplicate our entries", async () => {
  const home = await tempHome();
  await writeCursorConfig(cursorRuntime, home);
  const hooks1 = await readJson(cursorHooksPath(home));
  const mcp1 = await readJson(cursorMcpPath(home));
  await writeCursorConfig(cursorRuntime, home);
  const hooks2 = await readJson(cursorHooksPath(home));
  const mcp2 = await readJson(cursorMcpPath(home));

  assert.deepEqual(hooks2, hooks1, "hooks.json byte-identical after re-run");
  assert.deepEqual(mcp2, mcp1, "mcp.json byte-identical after re-run");
  assert.equal(hooks2.hooks.stop.length, 1, "no duplicate stop entry");
  assert.equal(Object.keys(mcp2.mcpServers).length, 1);
});

test("uninstall removes EXACTLY our entries and preserves the user's", async () => {
  const home = await tempHome();
  await fs.mkdir(path.dirname(cursorHooksPath(home)), { recursive: true });
  await fs.writeFile(
    cursorHooksPath(home),
    JSON.stringify({
      version: 1,
      hooks: {
        stop: [{ command: "echo user-stop" }],
        beforeShell: [{ command: "echo user-before" }],
      },
    }),
  );
  await fs.writeFile(
    cursorMcpPath(home),
    JSON.stringify({ mcpServers: { "user-server": { command: "user-cmd" } } }),
  );

  await writeCursorConfig(cursorRuntime, home);
  assert.ok(await exists(cursorRulePath(home)), "rule written");

  const u = await uninstallCursorConfig(home);
  assert.ok(u.removed.includes(cursorHooksPath(home)));
  assert.ok(u.removed.includes(cursorMcpPath(home)));
  assert.ok(u.removed.includes(cursorRulePath(home)));

  const hooks = await readJson(cursorHooksPath(home));
  assert.equal(ourStopCount(hooks.hooks.stop), 0, "our stop entry removed");
  assert.equal(hooks.hooks.stop[0].command, "echo user-stop", "user's stop survives");
  assert.ok(hooks.hooks.beforeShell, "unrelated event preserved");
  assert.equal(hooks.version, 1, "version preserved");

  const mcp = await readJson(cursorMcpPath(home));
  assert.equal(mcp.mcpServers[MCP_SERVER_NAME], undefined, "our MCP entry removed");
  assert.deepEqual(mcp.mcpServers["user-server"], { command: "user-cmd" });

  assert.equal(await exists(cursorRulePath(home)), false, "rule file gone");
});

test("uninstall of a stop array that held ONLY our entry deletes the stop key", async () => {
  const home = await tempHome();
  await writeCursorConfig(cursorRuntime, home); // only our entries exist
  await uninstallCursorConfig(home);

  const hooks = await readJson(cursorHooksPath(home));
  assert.equal(hooks.hooks, undefined, "empty hooks object removed");
  assert.equal(hooks.version, 1, "version key remains (user-owned structure)");

  // mcp.json: our-only server removed → mcpServers object dropped.
  const mcp = await readJson(cursorMcpPath(home));
  assert.equal(mcp.mcpServers, undefined, "empty mcpServers object removed");
});

test("uninstall is a clean no-op when nothing was installed", async () => {
  const home = await tempHome();
  const u = await uninstallCursorConfig(home);
  assert.deepEqual(u.removed, []);
  assert.match(u.detail, /no gocode-notify entries/);
});

test("uninstall is idempotent (second run finds nothing left to remove)", async () => {
  const home = await tempHome();
  await writeCursorConfig(cursorRuntime, home);
  await uninstallCursorConfig(home);
  const second = await uninstallCursorConfig(home);
  assert.deepEqual(second.removed, []);
});

test("a malformed hooks.json fails gracefully (no clobber, failed:true)", async () => {
  const home = await tempHome();
  await fs.mkdir(path.dirname(cursorHooksPath(home)), { recursive: true });
  await fs.writeFile(cursorHooksPath(home), "{not valid json");
  const r = await writeCursorConfig(cursorRuntime, home);
  assert.equal(r.failed, true);
  assert.deepEqual(r.written, []);
  // The user's (broken) file is left untouched rather than overwritten.
  assert.equal(await fs.readFile(cursorHooksPath(home), "utf8"), "{not valid json");
});

test("a mid-way failure reports the paths already written (rule mkdir fails after hooks+mcp)", async () => {
  const home = await tempHome();
  // Make `rules` a FILE so mkdir of rules/ fails AFTER hooks.json + mcp.json land.
  await fs.mkdir(path.join(home.home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home.home, ".cursor", "rules"), "not a dir");
  const r = await writeCursorConfig(cursorRuntime, home);
  assert.equal(r.failed, true);
  assert.deepEqual(
    r.written,
    [cursorHooksPath(home), cursorMcpPath(home)],
    "hooks + mcp counted, rule not",
  );
});

test("defaultConfigWriter routes Cursor to writeCursorConfig", async () => {
  const home = await tempHome();
  const r = await defaultConfigWriter(cursorRuntime, home);
  assert.equal(r.runtime, CURSOR_RUNTIME_NAME);
  assert.equal(r.skipped, false);
  assert.ok(r.written.length >= 3);
  assert.ok(await exists(cursorHooksPath(home)));
  assert.ok(await exists(cursorMcpPath(home)));
  assert.ok(await exists(cursorRulesDir(home)));
});
