// Tests for `--agent-driven` structured JSON output (PRD §4.4): every command,
// when run with `--agent-driven`, emits one JSON line per step in the canonical
// shape { "step": ..., "ok": ..., "detail": ... } to stdout. Here we verify the
// shape itself (formatStep / isAgentDriven / formatStatusSteps) and that each
// implemented command (login / send / test / status) routes through the sink
// instead of human output. A collecting sink is injected so no real stdout is
// captured and no real network or HOME is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatStep, isAgentDriven, type StepLine, type StepSink } from "../src/agent.js";
import { formatStatusSteps, type StatusReport } from "../src/status.js";
import { writeCredentials, type Credentials } from "../src/creds.js";
import { parseFlags, cmdLogin, cmdSend, cmdTest, cmdStatus } from "../src/cli.js";

/** Fresh temp HOME pointing PathOpts at it. */
async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-agent-"));
  return { home };
}

async function pair(home: { home: string }, server = "https://creds.invalid"): Promise<void> {
  const creds: Credentials = {
    api_key: "gck_testkey0000000000000000000000",
    server,
    user_id: "github:123",
    label: "Test — Cursor",
  };
  await writeCredentials(creds, home);
}

/** A collecting sink: returns it plus the array it appends to. */
function collector(): { sink: StepSink; lines: StepLine[] } {
  const lines: StepLine[] = [];
  return { sink: (l) => lines.push(l), lines };
}

/** A fetch stub that always resolves with the given status + a sent count. */
function okFetch(status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true, sent: 2 }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** A fetch stub returning a valid /pair/claim response (for cmdLogin). */
function loginFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ api_key: "gck_minted0000000000000000000000", user_id: "github:7", label: "Lbl" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** A fetch stub that always rejects (simulates an unreachable host). */
function deadFetch(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

// --- the JSON-line shape ----------------------------------------------------

test("formatStep emits the canonical {step,ok,detail} JSON, single line", () => {
  const line = formatStep({ step: "send", ok: true, detail: "sent finished" });
  assert.equal(line, '{"step":"send","ok":true,"detail":"sent finished"}');
  assert.ok(!line.includes("\n"), "a step is exactly one line");
  // Round-trips and keeps a fixed key set.
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed), ["step", "ok", "detail"]);
});

test("formatStep JSON-escapes details containing newlines/quotes", () => {
  const line = formatStep({ step: "x", ok: false, detail: 'a "b"\nc' });
  assert.ok(!line.includes("\n"), "no raw newline leaks into the line");
  assert.equal(JSON.parse(line).detail, 'a "b"\nc');
});

test("isAgentDriven recognizes the bare flag and =true, rejects others", () => {
  assert.equal(isAgentDriven(parseFlags(["--agent-driven"])), true);
  assert.equal(isAgentDriven(parseFlags(["--agent-driven=true"])), true);
  assert.equal(isAgentDriven(parseFlags(["--agent-driven=false"])), false);
  assert.equal(isAgentDriven(parseFlags([])), false);
});

// --- status report → steps --------------------------------------------------

test("formatStatusSteps emits one step per report element with the right ok", () => {
  const report: StatusReport = {
    credentials: { present: true, path: "/h/.gocode/credentials", user_id: "github:9", label: "Lbl" },
    server: { url: "https://x", reachable: false, detail: "timeout after 3000ms" },
    runtimes: [
      { name: "Claude Code", detected: true, configPath: "/h/.claude/settings.json", configWritten: true },
      { name: "Cursor", detected: false, configPath: "/h/.cursor/hooks.json", configWritten: false },
    ],
  };
  const steps = formatStatusSteps(report);
  assert.deepEqual(
    steps.map((s) => [s.step, s.ok]),
    [
      ["credentials", true],
      ["server", false],
      ["runtime:Claude Code", true],
      ["runtime:Cursor", false],
    ],
  );
  assert.equal(steps[0].detail, "paired as github:9 (Lbl)");
  assert.equal(steps[2].detail, "detected (config written)");
});

test("formatStatusSteps reports not-paired credentials as ok:false", () => {
  const report: StatusReport = {
    credentials: { present: false, path: "/h/.gocode/credentials" },
    server: { url: "https://x", reachable: true, detail: "HTTP 200" },
    runtimes: [],
  };
  const [creds] = formatStatusSteps(report);
  assert.equal(creds.ok, false);
  assert.equal(creds.detail, "not paired");
});

// --- commands route through the sink ---------------------------------------

test("cmdStatus --agent-driven emits parseable JSON step lines, no human output", async () => {
  const home = await tempHome();
  await pair(home);
  const { sink, lines } = collector();
  // console.log spy: agent-driven mode must NOT print human lines.
  const realLog = console.log;
  let humanLines = 0;
  console.log = () => {
    humanLines++;
  };
  try {
    const code = await cmdStatus(["--agent-driven"], { home: home.home, fetchImpl: okFetch(), sink });
    assert.equal(code, 0);
  } finally {
    console.log = realLog;
  }
  assert.equal(humanLines, 0, "agent-driven mode suppresses human console output");
  // credentials + server + 3 runtimes.
  assert.equal(lines.length, 5);
  for (const l of lines) {
    assert.deepEqual(Object.keys(JSON.parse(formatStep(l))), ["step", "ok", "detail"]);
  }
  assert.equal(lines[0].step, "credentials");
  assert.equal(lines[0].ok, true);
});

test("cmdSend --agent-driven emits a send:true step on success", async () => {
  const home = await tempHome();
  await pair(home, "https://srv.invalid");
  const { sink, lines } = collector();
  const code = await cmdSend(["--kind", "finished", "--agent-driven", "--server", "https://srv.invalid"], {
    home: home.home,
    fetchImpl: okFetch(),
    sink,
  });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "send");
  assert.equal(lines[0].ok, true);
  assert.match(lines[0].detail, /finished/);
});

test("cmdSend --agent-driven emits a send:false step (still exit 0) on failure", async () => {
  const home = await tempHome();
  await pair(home, "https://srv.invalid");
  const { sink, lines } = collector();
  const code = await cmdSend(["--kind", "error", "--agent-driven"], {
    home: home.home,
    fetchImpl: deadFetch(),
    sink,
  });
  assert.equal(code, 0, "a failed send must still exit 0");
  assert.equal(lines[0].step, "send");
  assert.equal(lines[0].ok, false);
  assert.match(lines[0].detail, /queued for retry/);
});

test("cmdSend --agent-driven emits a validate:false step for a bad kind (exit 2)", async () => {
  const home = await tempHome();
  await pair(home);
  const { sink, lines } = collector();
  const code = await cmdSend(["--kind", "nope", "--agent-driven"], { home: home.home, sink });
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "validate");
  assert.equal(lines[0].ok, false);
});

test("cmdTest --agent-driven emits a test:true step on success", async () => {
  const home = await tempHome();
  await pair(home, "https://srv.invalid");
  const { sink, lines } = collector();
  const code = await cmdTest(["--agent-driven", "--server", "https://srv.invalid"], {
    home: home.home,
    fetchImpl: okFetch(),
    sink,
  });
  assert.equal(code, 0);
  assert.equal(lines[0].step, "test");
  assert.equal(lines[0].ok, true);
});

test("cmdLogin --agent-driven without --code fails fast (no stdin prompt) as ok:false", async () => {
  // With no --code and no injected promptCode, agent-driven mode must NOT fall
  // into a readline prompt (which would hang on stdin). It injects a fail-fast
  // prompt internally, so cmdLogin returns exit 1 with a login:false step — the
  // test completing at all proves it never blocked on stdin.
  const home = await tempHome();
  const { sink, lines } = collector();
  const code = await cmdLogin(["--agent-driven"], { home: home.home, sink });
  assert.equal(code, 1, "absent --code in agent-driven mode is an error, not a prompt");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "login");
  assert.equal(lines[0].ok, false);
});

test("cmdLogin --agent-driven emits a login:true step on a successful pair", async () => {
  const home = await tempHome();
  const { sink, lines } = collector();
  const code = await cmdLogin(["--code", "123456", "--agent-driven", "--server", "https://srv.invalid"], {
    home: home.home,
    fetchImpl: loginFetch(),
    sink,
  });
  assert.equal(code, 0);
  assert.equal(lines[0].step, "login");
  assert.equal(lines[0].ok, true);
  assert.match(lines[0].detail, /paired as/);
});
