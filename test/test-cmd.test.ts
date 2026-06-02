// Tests for the `gocode-notify test` CLI command (cmdTest): it posts the canned
// `finished` / "GoCode test" payload (PRD §4.1) and — unlike `send` — exits
// NON-zero on failure since it is an interactive post-install diagnostic, not a
// fire-and-forget hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeCredentials, type Credentials } from "../src/creds.js";
import { listOutbox } from "../src/outbox.js";
import { cmdTest, TEST_PAYLOAD } from "../src/cli.js";

/** Fresh temp HOME pointing PathOpts at it. */
async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-test-cmd-"));
  return { home };
}

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Start a mock notify server; `status()` is consulted per request. */
async function mockServer(
  status: () => number,
): Promise<{ url: string; close: () => Promise<void>; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const code = status();
      if (code >= 200 && code < 300) {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sent: 2, fcm_enabled: true }));
      } else {
        res.writeHead(code);
        res.end("boom");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function pair(home: { home: string }, server: string): Promise<void> {
  const creds: Credentials = {
    api_key: "gck_testkey0000000000000000000000",
    server,
    user_id: "github:123",
    label: "Test — Cursor",
  };
  await writeCredentials(creds, home);
}

/** Run `fn` with console.log/error silenced (keeps test output readable). */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

test("TEST_PAYLOAD is the canned finished/GoCode-test push (PRD §4.1)", () => {
  assert.equal(TEST_PAYLOAD.kind, "finished");
  assert.equal(TEST_PAYLOAD.title, "GoCode test");
});

test("cmdTest posts the canned payload once and exits 0 on success", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const code = await quiet(() => cmdTest([], home));
  assert.equal(code, 0);
  assert.equal(srv.requests.length, 1);
  const req = srv.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/v1/notify/send");
  assert.equal(req.headers.authorization, "Bearer gck_testkey0000000000000000000000");
  const sent = JSON.parse(req.body);
  assert.equal(sent.kind, "finished");
  assert.equal(sent.title, "GoCode test");
});

test("cmdTest exits 1 on a server failure (diagnostic, NOT fire-and-forget)", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 500);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const code = await quiet(() => cmdTest([], home));
  assert.equal(code, 1, "test is a diagnostic — a failed delivery must surface as non-zero");
});

test("cmdTest does NOT queue to the outbox on failure", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 500);
  t.after(() => srv.close());
  await pair(home, srv.url);

  await quiet(() => cmdTest([], home));
  assert.deepEqual(await listOutbox(home), [], "a one-shot probe should not leave a stale test push queued");
});

test("cmdTest exits 1 when not paired (no credentials)", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  // Intentionally NOT paired.

  const code = await quiet(() => cmdTest(["--server", srv.url], home));
  assert.equal(code, 1);
  assert.equal(srv.requests.length, 0, "an unpaired test must not hit the network");
});

test("cmdTest honors --server over the credentials server", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, "https://unused.invalid");

  const code = await quiet(() => cmdTest(["--server", srv.url], home));
  assert.equal(code, 0);
  assert.equal(srv.requests.length, 1);
});
