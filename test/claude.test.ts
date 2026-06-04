// Tests for the Claude Code config writer (PRD §5.3, §5.5, §11). All run against
// a fresh temp HOME so we never touch the real ~/.claude. Cover: fresh install
// (hooks + MCP + skill), MERGE (preserve the user's own entries), idempotency
// (re-run does not duplicate), and surgical uninstall (remove exactly ours).
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeClaudeConfig,
  uninstallClaudeConfig,
  claudeSettingsPath,
  claudeSkillPath,
  claudeSkillDir,
  CLAUDE_RUNTIME_NAME,
  MCP_SERVER_NAME,
  CLAUDE_HOOK_COMMANDS,
  SKILL_CONTENT,
} from "../src/claude.js";
import { defaultConfigWriter, pendingConfigWriter } from "../src/setup.js";
import type { RuntimeStatus } from "../src/detect.js";

async function tempHome(): Promise<{ home: string }> {
  return { home: await fs.mkdtemp(path.join(os.tmpdir(), "gocode-claude-")) };
}

async function readSettings(opts: { home: string }): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(claudeSettingsPath(opts), "utf8"));
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

/** Each event's array holds exactly N of OUR groups. */
function ourGroupCount(arr: unknown[]): number {
  return arr.filter(
    (g: any) =>
      Array.isArray(g?.hooks) &&
      g.hooks.some(
        (h: any) =>
          typeof h?.command === "string" &&
          h.command.includes("notify send") &&
          h.command.includes("--source claude_code"),
      ),
  ).length;
}

test("fresh install writes all three hooks, the MCP entry, and the skill", async () => {
  const home = await tempHome();
  const r = await writeClaudeConfig(claudeRuntime, home);

  assert.equal(r.runtime, CLAUDE_RUNTIME_NAME);
  assert.equal(r.skipped, false);
  assert.notEqual(r.failed, true);
  assert.deepEqual(r.written, [claudeSettingsPath(home), claudeSkillPath(home)]);

  const s = await readSettings(home);
  for (const [event, command] of Object.entries(CLAUDE_HOOK_COMMANDS)) {
    assert.ok(Array.isArray(s.hooks[event]), `${event} present`);
    assert.equal(ourGroupCount(s.hooks[event]), 1, `one ${event} group`);
    assert.equal(s.hooks[event][0].hooks[0].type, "command");
    assert.equal(s.hooks[event][0].hooks[0].command, command);
  }
  assert.deepEqual(s.mcpServers[MCP_SERVER_NAME], {
    command: "npx",
    args: ["-y", "@trygocode/notify", "mcp"],
  });

  const skill = await fs.readFile(claudeSkillPath(home), "utf8");
  assert.equal(skill, SKILL_CONTENT);
  assert.match(skill, /do NOT double-notify/i);
  assert.match(skill, /name: gocode-notify/);
});

test("MERGE preserves the user's existing hooks, MCP servers, and other keys", async () => {
  const home = await tempHome();
  await fs.mkdir(path.dirname(claudeSettingsPath(home)), { recursive: true });
  await fs.writeFile(
    claudeSettingsPath(home),
    JSON.stringify({
      model: "claude-opus-4-8",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo user-stop-hook" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "echo user-pre" }] }],
      },
      mcpServers: { "user-server": { command: "user-cmd" } },
    }),
  );

  await writeClaudeConfig(claudeRuntime, home);
  const s = await readSettings(home);

  // Top-level + unrelated keys preserved.
  assert.equal(s.model, "claude-opus-4-8");
  assert.ok(s.hooks.PreToolUse, "unrelated hook event preserved");
  assert.deepEqual(s.mcpServers["user-server"], { command: "user-cmd" });

  // Stop now has BOTH the user's group and ours.
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.Stop[0].hooks[0].command, "echo user-stop-hook");
  assert.equal(ourGroupCount(s.hooks.Stop), 1);
  // Our MCP entry added alongside the user's.
  assert.ok(s.mcpServers[MCP_SERVER_NAME]);
});

test("install is idempotent: re-running does not duplicate our entries", async () => {
  const home = await tempHome();
  await writeClaudeConfig(claudeRuntime, home);
  const first = await readSettings(home);
  await writeClaudeConfig(claudeRuntime, home);
  const second = await readSettings(home);

  // Byte-for-byte identical after a second run.
  assert.deepEqual(second, first);
  for (const event of Object.keys(CLAUDE_HOOK_COMMANDS)) {
    assert.equal(second.hooks[event].length, 1, `no duplicate ${event} group`);
  }
  assert.equal(Object.keys(second.mcpServers).length, 1);
});

test("uninstall removes EXACTLY our entries and preserves the user's", async () => {
  const home = await tempHome();
  await fs.mkdir(path.dirname(claudeSettingsPath(home)), { recursive: true });
  await fs.writeFile(
    claudeSettingsPath(home),
    JSON.stringify({
      model: "x",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo user-stop-hook" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "echo user-pre" }] }],
      },
      mcpServers: { "user-server": { command: "user-cmd" } },
    }),
  );

  await writeClaudeConfig(claudeRuntime, home);
  assert.ok(await exists(claudeSkillPath(home)), "skill written");

  const u = await uninstallClaudeConfig(home);
  assert.ok(u.removed.includes(claudeSettingsPath(home)));
  assert.ok(u.removed.includes(claudeSkillDir(home)));

  const s = await readSettings(home);
  // Our stuff gone.
  assert.equal(ourGroupCount(s.hooks.Stop), 0, "our Stop group removed");
  assert.equal(s.hooks.Notification, undefined, "our-only event key deleted");
  assert.equal(s.hooks.SubagentStop, undefined, "our-only event key deleted");
  assert.equal(s.mcpServers[MCP_SERVER_NAME], undefined, "our MCP entry removed");
  // User's stuff preserved.
  assert.equal(s.model, "x");
  assert.equal(s.hooks.Stop[0].hooks[0].command, "echo user-stop-hook");
  assert.ok(s.hooks.PreToolUse, "unrelated event preserved");
  assert.deepEqual(s.mcpServers["user-server"], { command: "user-cmd" });
  // Skill dir gone.
  assert.equal(await exists(claudeSkillDir(home)), false);
});

test("merge + uninstall operate at the command level: a user command sharing a group with ours survives", async () => {
  const home = await tempHome();
  await fs.mkdir(path.dirname(claudeSettingsPath(home)), { recursive: true });
  // A MIXED group: our Stop command alongside a user's command in the same group.
  await fs.writeFile(
    claudeSettingsPath(home),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: CLAUDE_HOOK_COMMANDS.Stop },
              { type: "command", command: "echo user-extra" },
            ],
          },
        ],
      },
    }),
  );

  // Re-install: our command is de-duped, the user's command in that group stays.
  await writeClaudeConfig(claudeRuntime, home);
  let s = await readSettings(home);
  const allStopCommands = (group: any) => group.hooks.map((h: any) => h.command);
  const stopCmds = s.hooks.Stop.flatMap(allStopCommands);
  assert.ok(stopCmds.includes("echo user-extra"), "user command preserved on merge");
  assert.equal(
    stopCmds.filter((c: string) => c === CLAUDE_HOOK_COMMANDS.Stop).length,
    1,
    "our command appears exactly once (no duplicate)",
  );

  // Uninstall: our command goes, the user's command remains.
  await uninstallClaudeConfig(home);
  s = await readSettings(home);
  const after = s.hooks.Stop.flatMap(allStopCommands);
  assert.ok(after.includes("echo user-extra"), "user command survives uninstall");
  assert.equal(ourGroupCount(s.hooks.Stop), 0, "our command removed");
});

test("a mid-way failure reports the paths already written (skill mkdir fails after settings write)", async () => {
  const home = await tempHome();
  // Make `skills` a FILE so mkdir of skills/gocode-notify fails AFTER settings.json
  // has already been written.
  await fs.mkdir(path.join(home.home, ".claude"), { recursive: true });
  await fs.writeFile(path.join(home.home, ".claude", "skills"), "not a dir");
  const r = await writeClaudeConfig(claudeRuntime, home);
  assert.equal(r.failed, true);
  assert.deepEqual(r.written, [claudeSettingsPath(home)], "settings counted, skill not");
});

test("uninstall of a Stop event that held ONLY our group deletes the event key", async () => {
  const home = await tempHome();
  await writeClaudeConfig(claudeRuntime, home); // only our hooks exist
  await uninstallClaudeConfig(home);
  const s = await readSettings(home);
  // All three events were our-only → hooks object should be gone entirely.
  assert.equal(s.hooks, undefined, "empty hooks object removed");
  assert.equal(s.mcpServers, undefined, "empty mcpServers object removed");
});

test("uninstall is a clean no-op when nothing was installed", async () => {
  const home = await tempHome();
  const u = await uninstallClaudeConfig(home);
  assert.deepEqual(u.removed, []);
  assert.match(u.detail, /no gocode-notify entries/);
});

test("uninstall is idempotent (second run finds nothing left to remove)", async () => {
  const home = await tempHome();
  await writeClaudeConfig(claudeRuntime, home);
  await uninstallClaudeConfig(home);
  const second = await uninstallClaudeConfig(home);
  assert.deepEqual(second.removed, []);
});

test("a malformed settings.json fails gracefully (no clobber, failed:true)", async () => {
  const home = await tempHome();
  await fs.mkdir(path.dirname(claudeSettingsPath(home)), { recursive: true });
  await fs.writeFile(claudeSettingsPath(home), "{not valid json");
  const r = await writeClaudeConfig(claudeRuntime, home);
  assert.equal(r.failed, true);
  assert.deepEqual(r.written, []);
  // The user's (broken) file is left untouched rather than overwritten.
  assert.equal(await fs.readFile(claudeSettingsPath(home), "utf8"), "{not valid json");
});

test("defaultConfigWriter routes Claude Code to writeClaudeConfig, others to pending", async () => {
  const home = await tempHome();
  const claude = await defaultConfigWriter(claudeRuntime, home);
  assert.equal(claude.skipped, false);
  assert.ok(claude.written.length >= 2);
  assert.ok(await exists(claudeSettingsPath(home)));

  // OpenCode's writer has not landed yet → still routes to pending.
  const opencode: RuntimeStatus = { name: "OpenCode", detected: true, configPath: "", configWritten: false };
  const pending = await defaultConfigWriter(opencode, home);
  assert.equal(pending.skipped, true);
  assert.deepEqual(pending.written, []);
  // Sanity: pendingConfigWriter still behaves as before.
  assert.equal((await pendingConfigWriter(opencode, home)).skipped, true);
});
