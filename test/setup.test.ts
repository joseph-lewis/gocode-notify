// Tests for `gocode-notify setup` orchestration (PRD §5): pair → detect runtimes
// → write configs → summary, idempotent, `--force` re-pair. The per-runtime
// config writers are dedicated follow-up tasks, so here we inject the pair,
// detect, and write-config seams to assert the ORCHESTRATION wiring + idempotency
// without touching the network or the real home dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCredentials, type Credentials } from "../src/creds.js";
import type { RuntimeStatus } from "../src/status.js";
import type { LoginOptions, LoginResult } from "../src/login.js";
import { setup, pendingConfigWriter, type ConfigWriteResult } from "../src/setup.js";
import { cmdSetup } from "../src/cli.js";
import { type StepLine } from "../src/agent.js";

/** Fresh temp HOME pointing PathOpts at it. */
async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-setup-"));
  return { home };
}

async function pair(home: { home: string }): Promise<void> {
  const creds: Credentials = {
    api_key: "gck_testkey0000000000000000000000",
    server: "https://creds.invalid",
    user_id: "github:123",
    label: "MacBook Pro — Cursor",
  };
  await writeCredentials(creds, home);
}

/** A pair stub that records its calls and returns a fixed result. */
function spyPair(result: LoginResult): { impl: (o: LoginOptions) => Promise<LoginResult>; calls: LoginOptions[] } {
  const calls: LoginOptions[] = [];
  return {
    calls,
    impl: async (o) => {
      calls.push(o);
      return result;
    },
  };
}

const okPair: LoginResult = {
  ok: true,
  credentials: {
    api_key: "gck_freshkey000000000000000000000",
    server: "https://oh.jeltechsolutions.com",
    user_id: "github:999",
    label: "fresh",
  },
};

/** A detector stub returning the given runtimes verbatim. */
function detectStub(...detected: string[]): (o?: { home?: string }) => Promise<RuntimeStatus[]> {
  const all = ["Claude Code", "Cursor", "OpenCode"];
  return async () =>
    all.map((name) => ({
      name,
      detected: detected.includes(name),
      configPath: `/h/${name}`,
      configWritten: false,
    }));
}

/** A config writer that records which runtimes it was asked to write. */
function spyWriter(): {
  impl: (r: RuntimeStatus) => Promise<ConfigWriteResult>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    impl: async (r) => {
      calls.push(r.name);
      return { runtime: r.name, written: [`/h/${r.name}/config`], skipped: false, detail: "written" };
    },
  };
}

/** Run `fn` with console.log silenced. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

test("setup pairs, detects, and writes configs for detected runtimes only", async () => {
  const home = await tempHome();
  const pairSpy = spyPair(okPair);
  const writer = spyWriter();
  const result = await setup({
    home: home.home,
    pairCode: "123456",
    pairImpl: pairSpy.impl,
    detectImpl: detectStub("Claude Code", "Cursor"),
    writeConfig: writer.impl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.pair.skipped, false);
  assert.equal(pairSpy.calls.length, 1, "pairs on a fresh machine");
  // Only the two DETECTED runtimes get a writer call (OpenCode skipped).
  assert.deepEqual(writer.calls, ["Claude Code", "Cursor"]);
  assert.equal(result.configs.length, 2);
  // Step order: pair, detect, config:* (×2), summary.
  assert.deepEqual(
    result.steps.map((s) => s.step),
    ["pair", "detect", "config:Claude Code", "config:Cursor", "summary"],
  );
});

test("setup is idempotent: existing creds + no --force skips pairing", async () => {
  const home = await tempHome();
  await pair(home);
  const pairSpy = spyPair(okPair);
  const result = await setup({
    home: home.home,
    pairImpl: pairSpy.impl,
    detectImpl: detectStub(),
  });

  assert.equal(pairSpy.calls.length, 0, "must NOT re-pair when already paired");
  assert.equal(result.pair.skipped, true);
  assert.equal(result.pair.ok, true);
  assert.equal(result.pair.credentials?.user_id, "github:123");
  assert.equal(result.steps[0].step, "pair (skipped)");
  assert.equal(result.ok, true);
});

test("--force re-pairs even when credentials already exist", async () => {
  const home = await tempHome();
  await pair(home);
  const pairSpy = spyPair(okPair);
  const result = await setup({
    home: home.home,
    force: true,
    pairCode: "654321",
    pairImpl: pairSpy.impl,
    detectImpl: detectStub(),
  });

  assert.equal(pairSpy.calls.length, 1, "--force re-pairs");
  assert.equal(pairSpy.calls[0].code, "654321");
  assert.equal(result.pair.skipped, false);
  assert.equal(result.pair.credentials?.user_id, "github:999");
});

test("a malformed credentials file re-pairs (no --force needed to recover)", async () => {
  const home = await tempHome();
  await fs.mkdir(path.join(home.home, ".gocode"), { recursive: true });
  await fs.writeFile(path.join(home.home, ".gocode", "credentials"), "{not json");
  const pairSpy = spyPair(okPair);
  const result = await setup({
    home: home.home,
    pairCode: "111111",
    pairImpl: pairSpy.impl,
    detectImpl: detectStub(),
  });
  assert.equal(pairSpy.calls.length, 1, "corrupt creds → re-pair to recover");
  assert.equal(result.pair.skipped, false);
});

test("a failed pairing yields ok:false and a failing summary", async () => {
  const home = await tempHome();
  const pairSpy = spyPair({ ok: false, error: "bad code" });
  const result = await setup({
    home: home.home,
    pairCode: "000000",
    pairImpl: pairSpy.impl,
    detectImpl: detectStub("Cursor"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.pair.ok, false);
  assert.match(result.pair.detail, /bad code/);
  assert.equal(result.steps.at(-1)?.step, "summary");
  assert.equal(result.steps.at(-1)?.ok, false);
});

test("the default config writer reports a runtime without a writer as pending", async () => {
  const home = await tempHome();
  const result = await setup({
    home: home.home,
    pairCode: "123456",
    pairImpl: spyPair(okPair).impl,
    // OpenCode's writer has not landed yet → defaultConfigWriter falls through to
    // pendingConfigWriter (Claude Code and Cursor, by contrast, route to real writers).
    detectImpl: detectStub("OpenCode"),
    // no writeConfig → defaultConfigWriter
  });
  assert.equal(result.configs.length, 1);
  assert.equal(result.configs[0].skipped, true);
  assert.deepEqual(result.configs[0].written, []);
  // Pending is not a failure → setup still ok.
  assert.equal(result.ok, true);
});

test("the default config writer routes Claude Code to the real writer", async () => {
  const home = await tempHome();
  const result = await setup({
    home: home.home,
    pairCode: "123456",
    pairImpl: spyPair(okPair).impl,
    detectImpl: detectStub("Claude Code"),
    // no writeConfig → defaultConfigWriter → writeClaudeConfig
  });
  assert.equal(result.configs.length, 1);
  assert.equal(result.configs[0].skipped, false);
  assert.ok(result.configs[0].written.length >= 2, "settings.json + skill written");
  assert.equal(result.ok, true);
  // The real writer actually created the settings file under the temp HOME.
  const settings = JSON.parse(
    await fs.readFile(path.join(home.home, ".claude", "settings.json"), "utf8"),
  );
  assert.ok(settings.hooks?.Stop, "Stop hook merged");
  assert.ok(settings.mcpServers?.["gocode-notify"], "MCP entry merged");
});

test("pendingConfigWriter writes nothing (idempotent) and never fails", async () => {
  const runtime: RuntimeStatus = {
    name: "Cursor",
    detected: true,
    configPath: "/h/.cursor/hooks.json",
    configWritten: false,
  };
  const r = await pendingConfigWriter(runtime, {});
  assert.equal(r.runtime, "Cursor");
  assert.deepEqual(r.written, []);
  assert.equal(r.skipped, true);
  assert.notEqual(r.failed, true);
});

test("a hard config-write failure flips overall ok to false", async () => {
  const home = await tempHome();
  const failing = async (r: RuntimeStatus): Promise<ConfigWriteResult> => ({
    runtime: r.name,
    written: [],
    skipped: false,
    failed: true,
    detail: "permission denied",
  });
  const result = await setup({
    home: home.home,
    pairCode: "123456",
    pairImpl: spyPair(okPair).impl,
    detectImpl: detectStub("Cursor"),
    writeConfig: failing,
  });
  assert.equal(result.ok, false);
  assert.equal(result.configs[0].failed, true);
  assert.equal(result.steps.find((s) => s.step === "config:Cursor")?.ok, false);
});

test("cmdSetup --agent-driven emits one valid JSON StepLine per step", async () => {
  const home = await tempHome();
  const lines: StepLine[] = [];
  const code = await cmdSetup(["--agent-driven", "--pair-code", "123456"], {
    home: home.home,
    pairImpl: spyPair(okPair).impl,
    detectImpl: detectStub("Cursor"),
    sink: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  const steps = lines.map((l) => l.step);
  assert.ok(steps.includes("pair"));
  assert.ok(steps.includes("detect"));
  assert.ok(steps.includes("config:Cursor"));
  assert.equal(steps.at(-1), "summary");
  // Every line is a well-formed StepLine.
  for (const l of lines) {
    assert.equal(typeof l.step, "string");
    assert.equal(typeof l.ok, "boolean");
    assert.equal(typeof l.detail, "string");
  }
});

test("cmdSetup --agent-driven without --pair-code fails fast (no interactive prompt)", async () => {
  const home = await tempHome();
  const lines: StepLine[] = [];
  // Use the real default pair path (login) but force the network to never be
  // reached: an absent --pair-code in agent mode must fail at the prompt seam.
  const code = await cmdSetup(["--agent-driven"], {
    home: home.home,
    detectImpl: detectStub(),
    sink: (l) => lines.push(l),
  });
  assert.equal(code, 1, "no pair code + agent mode → setup fails, exit 1");
  const pairStep = lines.find((l) => l.step === "pair");
  assert.ok(pairStep && pairStep.ok === false, "pair step reports failure");
});

test("cmdSetup human mode exits 0 on a successful run", async () => {
  const home = await tempHome();
  const code = await quiet(() =>
    cmdSetup(["--pair-code", "123456"], {
      home: home.home,
      pairImpl: spyPair(okPair).impl,
      detectImpl: detectStub("Cursor"),
    }),
  );
  assert.equal(code, 0);
});
