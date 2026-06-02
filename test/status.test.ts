// Tests for `gocode-notify status` (gatherStatus / formatStatus / cmdStatus):
// it reports credentials presence, server reachability, and detected runtimes
// (PRD §4.1, §8). Reachability uses an injectable fetch and runtime detection
// uses a temp HOME, so no real network or real home dir is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCredentials, type Credentials } from "../src/creds.js";
import {
  gatherStatus,
  formatStatus,
  probeServer,
  RUNTIMES,
  type StatusReport,
} from "../src/status.js";
import { cmdStatus } from "../src/cli.js";

/** Fresh temp HOME pointing PathOpts at it. */
async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-status-"));
  return { home };
}

async function pair(home: { home: string }, server = "https://creds.invalid"): Promise<void> {
  const creds: Credentials = {
    api_key: "gck_testkey0000000000000000000000",
    server,
    user_id: "github:123",
    label: "MacBook Pro — Cursor",
  };
  await writeCredentials(creds, home);
}

/** A fetch stub that always resolves with the given status. */
function okFetch(status = 200): typeof fetch {
  return (async () => new Response("", { status })) as unknown as typeof fetch;
}

/** A fetch stub that always rejects (simulates an unreachable host). */
function deadFetch(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

/** Run `fn` with console.log/error silenced. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

test("RUNTIMES covers the three documented agent runtimes (PRD §5.2)", () => {
  const names = RUNTIMES.map((r) => r.name);
  assert.deepEqual(names, ["Claude Code", "Cursor", "OpenCode"]);
});

test("gatherStatus reports not-paired when no credentials exist", async () => {
  const home = await tempHome();
  const report = await gatherStatus({ home: home.home, fetchImpl: okFetch() });
  assert.equal(report.credentials.present, false);
  assert.equal(report.credentials.error, undefined);
  assert.ok(report.credentials.path.endsWith("/.gocode/credentials"));
});

test("gatherStatus reports the bound user/label when paired", async () => {
  const home = await tempHome();
  await pair(home);
  const report = await gatherStatus({ home: home.home, fetchImpl: okFetch() });
  assert.equal(report.credentials.present, true);
  assert.equal(report.credentials.user_id, "github:123");
  assert.equal(report.credentials.label, "MacBook Pro — Cursor");
});

test("gatherStatus surfaces a malformed credentials file as an error (not absent)", async () => {
  const home = await tempHome();
  await fs.mkdir(path.join(home.home, ".gocode"), { recursive: true });
  await fs.writeFile(path.join(home.home, ".gocode", "credentials"), "{not json");
  const report = await gatherStatus({ home: home.home, fetchImpl: okFetch() });
  assert.equal(report.credentials.present, false);
  assert.ok(report.credentials.error, "a malformed creds file must report an error");
});

test("gatherStatus marks the server reachable on any HTTP response", async () => {
  const home = await tempHome();
  const report = await gatherStatus({ home: home.home, fetchImpl: okFetch(404) });
  assert.equal(report.server.reachable, true, "even a 404 means the host answered");
  assert.equal(report.server.detail, "HTTP 404");
});

test("gatherStatus marks the server unreachable on a network error", async () => {
  const home = await tempHome();
  const report = await gatherStatus({ home: home.home, fetchImpl: deadFetch() });
  assert.equal(report.server.reachable, false);
  assert.match(report.server.detail, /ECONNREFUSED/);
});

test("gatherStatus honors --server precedence for the probed URL", async () => {
  const home = await tempHome();
  await pair(home, "https://creds.invalid");
  const report = await gatherStatus({
    home: home.home,
    serverFlag: "https://flag.example.com/",
    fetchImpl: okFetch(),
  });
  assert.equal(report.server.url, "https://flag.example.com", "flag wins and trailing slash is stripped");
});

test("gatherStatus detects a runtime only when its config dir exists", async () => {
  const home = await tempHome();
  await fs.mkdir(path.join(home.home, ".claude"), { recursive: true });
  const report = await gatherStatus({ home: home.home, fetchImpl: okFetch() });
  const byName = (n: string) => report.runtimes.find((r) => r.name === n)!;
  assert.equal(byName("Claude Code").detected, true);
  assert.equal(byName("Cursor").detected, false);
  assert.equal(byName("OpenCode").detected, false);
});

test("gatherStatus reports configWritten when the runtime config file exists", async () => {
  const home = await tempHome();
  await fs.mkdir(path.join(home.home, ".cursor"), { recursive: true });
  // Detected but no config yet.
  let report = await gatherStatus({ home: home.home, fetchImpl: okFetch() });
  let cursor = report.runtimes.find((r) => r.name === "Cursor")!;
  assert.equal(cursor.detected, true);
  assert.equal(cursor.configWritten, false);

  // Now write the config file → configWritten flips true.
  await fs.writeFile(path.join(home.home, ".cursor", "hooks.json"), "{}");
  report = await gatherStatus({ home: home.home, fetchImpl: okFetch() });
  cursor = report.runtimes.find((r) => r.name === "Cursor")!;
  assert.equal(cursor.configWritten, true);
});

test("OpenCode detection accepts either ~/.config/opencode or ~/.opencode", async () => {
  const home = await tempHome();
  await fs.mkdir(path.join(home.home, ".opencode"), { recursive: true });
  const report = await gatherStatus({ home: home.home, fetchImpl: okFetch() });
  const oc = report.runtimes.find((r) => r.name === "OpenCode")!;
  assert.equal(oc.detected, true);
  assert.ok(oc.configPath.includes(`.opencode${path.sep}mcp.json`));
});

test("probeServer times out without blocking", async () => {
  // A fetch that never resolves on its own; the AbortController must end it.
  const hangFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  const result = await probeServer("https://slow.invalid", { fetchImpl: hangFetch, timeoutMs: 20 });
  assert.equal(result.reachable, false);
  assert.match(result.detail, /timeout after 20ms/);
});

test("formatStatus renders coherent lines for a fully-populated report", () => {
  const report: StatusReport = {
    credentials: { present: true, path: "/h/.gocode/credentials", user_id: "github:9", label: "Lbl" },
    server: { url: "https://x", reachable: true, detail: "HTTP 200" },
    runtimes: [
      { name: "Claude Code", detected: true, configPath: "/h/.claude/settings.json", configWritten: true },
      { name: "Cursor", detected: false, configPath: "/h/.cursor/hooks.json", configWritten: false },
    ],
  };
  const out = formatStatus(report).join("\n");
  assert.match(out, /paired as github:9 \(Lbl\)/);
  assert.match(out, /Server: https:\/\/x \(HTTP 200\)/);
  assert.match(out, /Claude Code: detected \(config written\)/);
  assert.match(out, /Cursor: not detected/);
});

test("cmdStatus exits 0 regardless of state (informational)", async () => {
  const home = await tempHome();
  const code = await quiet(() => cmdStatus([], { home: home.home, fetchImpl: deadFetch() }));
  assert.equal(code, 0, "status is a report — it must never fail the shell");
});
