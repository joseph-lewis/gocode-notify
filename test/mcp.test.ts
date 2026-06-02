// Tests for the `gocode-notify mcp` server module (PRD §4.3): the exported
// TOOLS shape (exactly two tools with valid input schemas) and the two tool
// handlers — `gocode_notify` (validation + flag→payload mapping + non-blocking
// send) and `gocode_notify_status` (paired/unpaired self-diagnosis).
//
// The full JSON-RPC `initialize` + `tools/list` handshake over a transport is a
// separate tracker task; here we drive the handler functions directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeCredentials, type Credentials } from "../src/creds.js";
import { NOTIFY_KINDS } from "../src/send.js";
import {
  TOOLS,
  NOTIFY_TOOL,
  STATUS_TOOL,
  handleNotify,
  handleStatus,
} from "../src/mcp.js";

async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-mcp-"));
  return { home };
}

interface Captured {
  method: string;
  url: string;
  body: string;
}

/** Start a mock server answering both the send POST and the health GET probe. */
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
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const code = status();
      if (code >= 200 && code < 300) {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sent: 1 }));
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

const sendRequests = (reqs: Captured[]): Captured[] =>
  reqs.filter((r) => r.url === "/api/v1/notify/send");

test("TOOLS exposes exactly gocode_notify + gocode_notify_status", () => {
  assert.equal(TOOLS.length, 2);
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [NOTIFY_TOOL, STATUS_TOOL].sort());
});

test("gocode_notify schema requires title and enumerates the canonical kinds", () => {
  const notify = TOOLS.find((t) => t.name === NOTIFY_TOOL);
  assert.ok(notify);
  const schema = notify.inputSchema as {
    type: string;
    required?: string[];
    additionalProperties?: boolean;
    properties: Record<string, { enum?: unknown[] }>;
  };
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["title"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["body", "kind", "project", "title"]);
  assert.deepEqual(schema.properties.kind.enum, [...NOTIFY_KINDS]);
});

test("gocode_notify_status takes no arguments", () => {
  const status = TOOLS.find((t) => t.name === STATUS_TOOL);
  assert.ok(status);
  const schema = status.inputSchema as { type: string; properties: Record<string, unknown> };
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties), []);
});

test("handleNotify rejects a missing title without hitting the network", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const res = await handleNotify({}, home);
  assert.equal(res.isError, true);
  assert.equal(sendRequests(srv.requests).length, 0);
});

test("handleNotify rejects an invalid kind without hitting the network", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const res = await handleNotify({ title: "hi", kind: "nope" }, home);
  assert.equal(res.isError, true);
  assert.equal(sendRequests(srv.requests).length, 0);
});

test("handleNotify defaults kind to finished and posts once on success", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const res = await handleNotify({ title: "Build done" }, home);
  assert.notEqual(res.isError, true);
  const sends = sendRequests(srv.requests);
  assert.equal(sends.length, 1);
  const body = JSON.parse(sends[0].body);
  assert.equal(body.kind, "finished");
  assert.equal(body.title, "Build done");
  assert.equal(body.source, "mcp");
});

test("handleNotify maps body/project and an explicit kind into the payload", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const res = await handleNotify(
    { title: "Halted", body: "needs input", project: "OpenHandApp", kind: "loop_halted" },
    home,
  );
  assert.notEqual(res.isError, true);
  const body = JSON.parse(sendRequests(srv.requests)[0].body);
  assert.equal(body.kind, "loop_halted");
  assert.equal(body.body, "needs input");
  assert.equal(body.project, "OpenHandApp");
});

test("handleNotify reports an error (but does not throw) when delivery fails", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 500);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const res = await handleNotify({ title: "x" }, home);
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /Could not send/);
});

test("handleStatus flags an unpaired machine as an error", async () => {
  const home = await tempHome();
  const res = await handleStatus(home);
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /NOT paired/);
});

test("handleStatus reports ok when paired and the server is reachable", async (t) => {
  const home = await tempHome();
  const srv = await mockServer(() => 200);
  t.after(() => srv.close());
  await pair(home, srv.url);

  const res = await handleStatus(home);
  assert.notEqual(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /paired as github:123/);
  assert.match(text, /reachable/);
});
