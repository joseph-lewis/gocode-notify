import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeCredentials, type Credentials } from "../src/creds.js";
import {
  send,
  isNotifyKind,
  NOTIFY_KINDS,
  notifyLogPath,
  type SendPayload,
} from "../src/send.js";

/** Fresh temp HOME pointing PathOpts at it. */
async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-send-"));
  return { home };
}

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Start a one-shot mock notify server. `handler` decides the response per
 * request and receives the captured request for assertions.
 */
async function mockServer(
  handler: (req: Captured, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const captured: Captured = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      handler(captured, res);
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

test("isNotifyKind accepts the five canonical kinds and rejects others", () => {
  assert.deepEqual(
    [...NOTIFY_KINDS],
    ["finished", "error", "awaiting_input", "loop_completed", "loop_halted"],
  );
  for (const k of NOTIFY_KINDS) assert.ok(isNotifyKind(k));
  assert.equal(isNotifyKind("nope"), false);
  assert.equal(isNotifyKind(undefined), false);
});

test("send posts the right method/path/headers/body and returns sent count", async (t) => {
  const home = await tempHome();
  const srv = await mockServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sent: 2, fcm_enabled: true }));
  });
  t.after(() => srv.close());
  await pair(home, srv.url);

  const payload: SendPayload = {
    kind: "finished",
    title: "Done",
    source: "cursor",
    project: "OpenHandApp",
    // omitted optional fields must NOT appear in the body
  };
  const result = await send(payload, home);

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.sent, 2);

  assert.equal(srv.requests.length, 1);
  const req = srv.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/v1/notify/send");
  assert.equal(req.headers.authorization, "Bearer gck_testkey0000000000000000000000");
  assert.match(String(req.headers["content-type"]), /application\/json/);

  const sentBody = JSON.parse(req.body);
  assert.deepEqual(sentBody, {
    kind: "finished",
    title: "Done",
    source: "cursor",
    project: "OpenHandApp",
  });
  assert.ok(!("body" in sentBody), "undefined optional fields must be omitted");
  assert.ok(!("dedupe_key" in sentBody));
});

test("send is non-blocking on 5xx: resolves ok:false and logs the failure", async (t) => {
  const home = await tempHome();
  const srv = await mockServer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  t.after(() => srv.close());
  await pair(home, srv.url);

  const result = await send({ kind: "error" }, home);
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.match(result.error ?? "", /500/);

  // Failure was recorded to ~/.gocode/notify.log
  const log = await fs.readFile(notifyLogPath(home), "utf8");
  assert.match(log, /SEND FAIL: server responded 500 for kind=error/);
});

test("send is non-blocking on a network/timeout error (server never responds)", async (t) => {
  const home = await tempHome();
  // Server accepts the connection but never writes a response → forces a timeout.
  const srv = await mockServer(() => {
    /* intentionally no res.end() */
  });
  t.after(() => srv.close());
  await pair(home, srv.url);

  const result = await send({ kind: "finished" }, { ...home, timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timeout after 100ms/);

  const log = await fs.readFile(notifyLogPath(home), "utf8");
  assert.match(log, /SEND FAIL: timeout/);
});

test("send fails cleanly (ok:false) when no credentials are paired", async () => {
  const home = await tempHome();
  const result = await send({ kind: "finished" }, home);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /not paired/);

  const log = await fs.readFile(notifyLogPath(home), "utf8");
  assert.match(log, /not paired/);
});

test("explicit server option overrides the credentials server", async (t) => {
  const home = await tempHome();
  const srv = await mockServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sent: 1 }));
  });
  t.after(() => srv.close());
  // Pair against a bogus server, then override with the live one.
  await pair(home, "https://unused.invalid");

  const result = await send({ kind: "finished" }, { ...home, server: srv.url });
  assert.equal(result.ok, true);
  assert.equal(srv.requests.length, 1);
});
