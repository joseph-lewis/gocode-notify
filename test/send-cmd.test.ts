// Tests for the `gocode-notify send` CLI command (cmdSend): kind-enum
// validation, flag→payload mapping, the PRD §4.4 non-blocking contract
// (always exit 0 on a valid send), and offline-outbox enqueue/flush wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeCredentials, type Credentials } from "../src/creds.js";
import { listOutbox } from "../src/outbox.js";
import { cmdSend } from "../src/cli.js";

/** Fresh temp HOME pointing PathOpts at it. */
async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-send-cmd-"));
  return { home };
}

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Start a mock notify server. `status()` is consulted per request so a test can
 * flip the response code mid-run (e.g. 500 then 200 to exercise outbox flush).
 */
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
        res.end(JSON.stringify({ ok: true, sent: 1, fcm_enabled: true }));
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

test("cmdSend rejects a missing --kind with exit 2 and no request", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const code = await quiet(() => cmdSend([], home));
  assert.equal(code, 2);
  assert.equal(srv.requests.length, 0, "a usage error must not hit the network");
});

test("cmdSend rejects an invalid --kind with exit 2", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const code = await quiet(() => cmdSend(["--kind", "nope"], home));
  assert.equal(code, 2);
  assert.equal(srv.requests.length, 0);
});

test("cmdSend maps flags to the payload, posts once, and exits 0 on success", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const code = await quiet(() =>
    cmdSend(
      [
        "--kind",
        "finished",
        "--title",
        "Done",
        "--body",
        "All green",
        "--source",
        "cursor",
        "--project",
        "OpenHandApp",
        "--dedupe-key",
        "abc-123",
      ],
      home,
    ),
  );

  assert.equal(code, 0);
  assert.equal(srv.requests.length, 1);
  const req = srv.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/v1/notify/send");
  assert.equal(req.headers.authorization, "Bearer gck_testkey0000000000000000000000");
  assert.deepEqual(JSON.parse(req.body), {
    kind: "finished",
    title: "Done",
    body: "All green",
    source: "cursor",
    project: "OpenHandApp",
    dedupe_key: "abc-123",
  });
  // Nothing queued on a clean delivery.
  assert.deepEqual(await listOutbox(home), []);
});

test("cmdSend omits unset optional flags from the payload", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const code = await quiet(() => cmdSend(["--kind", "error"], home));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(srv.requests[0].body), { kind: "error" });
});

test("cmdSend exits 0 and queues to the outbox when delivery fails (non-blocking)", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 500);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const code = await quiet(() => cmdSend(["--kind", "finished"], home));
  assert.equal(code, 0, "a failed send must still exit 0 so a hook never blocks");
  const queued = await listOutbox(home);
  assert.equal(queued.length, 1, "the failed payload is queued for retry");
});

test("cmdSend flushes the queued outbox on a later successful send", async (t) => {
  const home = await tempHome();
  let code = 500;
  const srv = await mockServer(() => code);
  t.after(() => srv.close());
  await pair(home, srv.url);

  // First send fails → one entry queued.
  await quiet(() => cmdSend(["--kind", "loop_halted"], home));
  assert.equal((await listOutbox(home)).length, 1);

  // Server recovers; the next send succeeds AND drains the backlog.
  code = 200;
  const exit = await quiet(() => cmdSend(["--kind", "finished"], home));
  assert.equal(exit, 0);
  assert.deepEqual(await listOutbox(home), [], "backlog flushed once the server is reachable");

  // Requests observed: the failed loop_halted, the new finished, the flushed loop_halted.
  assert.equal(srv.requests.length, 3);
  const kinds = srv.requests.map((r) => JSON.parse(r.body).kind);
  assert.deepEqual(kinds, ["loop_halted", "finished", "loop_halted"]);
});

test("cmdSend honors --server over the credentials server", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  // Pair against a bogus server, then override with the live one via --server.
  await pair(home, "https://unused.invalid");

  const exit = await quiet(() => cmdSend(["--kind", "finished", "--server", srv.url], home));
  assert.equal(exit, 0);
  assert.equal(srv.requests.length, 1);
});
