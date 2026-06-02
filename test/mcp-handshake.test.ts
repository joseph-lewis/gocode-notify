// MCP handshake smoke test (PRD §8 "MCP mode smoke", tracker Milestone C).
//
// Drives a REAL JSON-RPC `initialize` + `tools/list` exchange against the
// server built by createMcpServer(), using the SDK's in-process linked
// transport pair (no stdio subprocess needed — same wire protocol, runs fast
// and deterministically inside `node --test`). Asserts the handshake succeeds,
// advertises the tools capability, and that `tools/list` returns EXACTLY the
// two tools with structurally-valid object input schemas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, NOTIFY_TOOL, STATUS_TOOL, SERVER_NAME } from "../src/mcp.js";
import { NOTIFY_KINDS } from "../src/send.js";

/**
 * Connect a fresh Client to a fresh server over a linked in-memory transport
 * pair. `client.connect()` performs the `initialize` handshake, so by the time
 * this resolves the protocol negotiation is done.
 */
async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gocode-notify-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("initialize handshake reports the gocode-notify server with tools capability", async (t) => {
  const { client, close } = await connectClient();
  t.after(close);

  const info = client.getServerVersion();
  assert.ok(info, "server info should be populated after initialize");
  assert.equal(info.name, SERVER_NAME);

  const caps = client.getServerCapabilities();
  assert.ok(caps?.tools, "server should advertise the tools capability");
});

test("tools/list returns exactly the two gocode tools", async (t) => {
  const { client, close } = await connectClient();
  t.after(close);

  const { tools } = await client.listTools();
  assert.equal(tools.length, 2);
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [NOTIFY_TOOL, STATUS_TOOL].sort());
});

test("every listed tool has a structurally valid object input schema", async (t) => {
  const { client, close } = await connectClient();
  t.after(close);

  const { tools } = await client.listTools();
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.ok((tool.description as string).length > 0, `${tool.name} should have a description`);
    const schema = tool.inputSchema as {
      type: string;
      properties?: Record<string, unknown>;
    };
    assert.equal(schema.type, "object", `${tool.name} input schema must be an object`);
    assert.equal(typeof schema.properties, "object", `${tool.name} must declare properties`);
  }
});

test("gocode_notify advertises its title-required, kind-enumerated schema over the wire", async (t) => {
  const { client, close } = await connectClient();
  t.after(close);

  const { tools } = await client.listTools();
  const notify = tools.find((tool) => tool.name === NOTIFY_TOOL);
  assert.ok(notify, "gocode_notify should be listed");
  const schema = notify.inputSchema as {
    required?: string[];
    additionalProperties?: boolean;
    properties: Record<string, { enum?: unknown[] }>;
  };
  assert.deepEqual(schema.required, ["title"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.kind.enum, [...NOTIFY_KINDS]);
});

test("gocode_notify_status advertises a no-argument schema over the wire", async (t) => {
  const { client, close } = await connectClient();
  t.after(close);

  const { tools } = await client.listTools();
  const status = tools.find((tool) => tool.name === STATUS_TOOL);
  assert.ok(status, "gocode_notify_status should be listed");
  const schema = status.inputSchema as { type: string; properties: Record<string, unknown> };
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties), []);
});
