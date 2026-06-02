import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readCredentials, credentialsPath } from "../src/creds.js";
import { login, claim, defaultLabel, CLAIM_PATH } from "../src/login.js";
import { parseFlags } from "../src/cli.js";

/** Fresh temp HOME pointing PathOpts at it. */
async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-login-"));
  return { home };
}

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Start a mock pairing server; `handler` decides the response per request. */
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

function okClaim(res: http.ServerResponse, extra: Record<string, unknown> = {}): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      api_key: "gck_minted000000000000000000000000",
      user_id: "github:123",
      label: "MacBook Pro — Cursor",
      ...extra,
    }),
  );
}

test("defaultLabel is a non-empty string", () => {
  const label = defaultLabel();
  assert.equal(typeof label, "string");
  assert.ok(label.length > 0);
});

test("login --code posts to /pair/claim and writes credentials", async (t) => {
  const home = await tempHome();
  const srv = await mockServer((_req, res) => okClaim(res));
  t.after(() => srv.close());

  const result = await login({ code: "123456", label: "My Mac", server: srv.url, ...home });

  assert.equal(result.ok, true);
  assert.equal(result.credentials?.api_key, "gck_minted000000000000000000000000");
  assert.equal(result.credentials?.user_id, "github:123");
  // Server echoed a label → it wins over the one we sent.
  assert.equal(result.credentials?.label, "MacBook Pro — Cursor");
  assert.equal(result.credentials?.server, srv.url);

  // Request shape: POST /pair/claim, JSON body {code,label}, NO auth header.
  assert.equal(srv.requests.length, 1);
  const req = srv.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, CLAIM_PATH);
  assert.equal(req.headers.authorization, undefined, "claim must not send an Authorization header");
  assert.match(String(req.headers["content-type"]), /application\/json/);
  assert.deepEqual(JSON.parse(req.body), { code: "123456", label: "My Mac" });

  // Credentials persisted to disk (chmod 600 covered by creds tests).
  const onDisk = await readCredentials(home);
  assert.equal(onDisk?.api_key, "gck_minted000000000000000000000000");
  assert.equal(onDisk?.server, srv.url);
});

test("login prompts interactively when --code is absent", async (t) => {
  const home = await tempHome();
  const srv = await mockServer((_req, res) => okClaim(res));
  t.after(() => srv.close());

  let prompted = 0;
  const result = await login({
    server: srv.url,
    ...home,
    promptCode: async () => {
      prompted++;
      return "  654321  "; // whitespace must be trimmed
    },
  });

  assert.equal(prompted, 1);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(srv.requests[0].body).code, "654321");
});

test("login falls back to defaultLabel when --label omitted", async (t) => {
  const home = await tempHome();
  // Echo back no label so the stored label is whatever we sent.
  const srv = await mockServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ api_key: "gck_x000000000000000000000000000000", user_id: "github:9" }));
  });
  t.after(() => srv.close());

  const result = await login({ code: "111111", server: srv.url, ...home });
  assert.equal(result.ok, true);
  const sent = JSON.parse(srv.requests[0].body).label;
  assert.equal(sent, defaultLabel());
  // No echoed label → stored label is the one we sent.
  assert.equal(result.credentials?.label, defaultLabel());
});

test("login rejects a non-6-digit code without hitting the network", async (t) => {
  const home = await tempHome();
  const srv = await mockServer((_req, res) => okClaim(res));
  t.after(() => srv.close());

  for (const bad of ["123", "1234567", "12a456", "  "]) {
    const result = await login({ code: bad, server: srv.url, ...home });
    assert.equal(result.ok, false, `code "${bad}" must be rejected`);
    assert.match(result.error ?? "", /6 digits/);
  }
  assert.equal(srv.requests.length, 0, "no claim request for an invalid code");
  // Nothing written on failure.
  await assert.rejects(() => fs.stat(credentialsPath(home)));
});

test("login returns ok:false on a server error and writes no credentials", async (t) => {
  const home = await tempHome();
  const srv = await mockServer((_req, res) => {
    res.writeHead(400);
    res.end("bad code");
  });
  t.after(() => srv.close());

  const result = await login({ code: "999999", server: srv.url, ...home });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error ?? "", /pairing failed/);
  await assert.rejects(() => fs.stat(credentialsPath(home)), "no creds on failed claim");
});

test("login is resilient to a network timeout", async (t) => {
  const home = await tempHome();
  // Accept the connection but never respond → forces the abort timeout.
  const srv = await mockServer(() => {
    /* no res.end() */
  });
  t.after(() => srv.close());

  const result = await login({ code: "222222", server: srv.url, timeoutMs: 100, ...home });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out/);
  await assert.rejects(() => fs.stat(credentialsPath(home)));
});

test("claim sends the raw {code,label} body and surfaces api_key/user_id", async (t) => {
  const srv = await mockServer((_req, res) => okClaim(res, { label: "Echoed" }));
  t.after(() => srv.close());

  const result = await claim("314159", "Lab", { server: srv.url });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.api_key, "gck_minted000000000000000000000000");
    assert.equal(result.data.user_id, "github:123");
    assert.equal(result.data.label, "Echoed");
  }
  assert.deepEqual(JSON.parse(srv.requests[0].body), { code: "314159", label: "Lab" });
});

test("claim flags a 2xx response missing required fields", async (t) => {
  const srv = await mockServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ user_id: "github:1" })); // no api_key
  });
  t.after(() => srv.close());

  const result = await claim("424242", "Lab", { server: srv.url });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /missing api_key/);
});

test("parseFlags handles --flag value, --flag=value, and bare booleans", () => {
  const flags = parseFlags(["--code", "123456", "--label=My Mac", "--force", "--server"]);
  assert.equal(flags.get("code"), "123456");
  assert.equal(flags.get("label"), "My Mac");
  assert.equal(flags.get("force"), true);
  assert.equal(flags.get("server"), true); // trailing flag with no value
});
