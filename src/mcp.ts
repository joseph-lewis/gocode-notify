// gocode-notify MCP server mode (`gocode-notify mcp`) — PRD §4.3.
//
// A minimal stdio MCP server exposing EXACTLY two tools (keep it tiny — more
// tools = more agent confusion):
//   - gocode_notify         → on-demand push (thin wrapper over internal send())
//   - gocode_notify_status  → creds-present + server-reachable self-diagnosis
//
// Both handlers funnel through the SAME internals as the CLI (`send()` /
// `gatherStatus()`), so behaviour is identical across every trigger (hook /
// loop / MCP / CLI). We use the official MCP TypeScript SDK low-level `Server`
// with raw JSON-Schema tool definitions — no zod in our OWN code — so the
// package's direct dependency stays just `@modelcontextprotocol/sdk`.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./version.js";
import { resolveServerUrl, type PathOpts } from "./creds.js";
import {
  send,
  isNotifyKind,
  NOTIFY_KINDS,
  type SendOptions,
  type SendPayload,
} from "./send.js";
import { gatherStatus } from "./status.js";

/** Server identity advertised in the MCP `initialize` handshake. */
export const SERVER_NAME = "gocode-notify";

/**
 * Public website for this MCP server, surfaced in the MCP `initialize`
 * handshake (`Implementation.websiteUrl`, SEP-973). Clients that support it
 * (MCP Inspector today; more clients over time) link the server to its docs.
 */
export const SERVER_WEBSITE_URL = "https://github.com/joseph-lewis/gocode-notify";

/**
 * Icons advertised in the MCP handshake (`Implementation.icons`, SEP-973) so
 * clients can show the GoCode mark next to this server in their UI. Served from
 * the public repo's `assets/` over GitHub's raw CDN so there's nothing to host.
 *
 * NOTE: as of 2026, Cursor does not yet RENDER custom MCP server icons (it uses
 * hardcoded marks for a few popular servers), so this stays invisible there for
 * now — but it already shows in MCP Inspector and other spec-compliant clients,
 * and will light up in Cursor automatically once it adds rendering. Cheap +
 * future-proof; no behaviour depends on it.
 */
export const SERVER_ICONS: { src: string; mimeType: string; sizes: string[] }[] = [
  {
    src: "https://raw.githubusercontent.com/joseph-lewis/gocode-notify/main/assets/icon-128.png",
    mimeType: "image/png",
    sizes: ["128x128"],
  },
  {
    src: "https://raw.githubusercontent.com/joseph-lewis/gocode-notify/main/assets/icon-512.png",
    mimeType: "image/png",
    sizes: ["512x512"],
  },
];

/** Tool name an agent calls to send an on-demand push. */
export const NOTIFY_TOOL = "gocode_notify";
/** Tool name an agent calls to self-diagnose pairing/reachability. */
export const STATUS_TOOL = "gocode_notify_status";

/**
 * The two tools this server exposes (PRD §4.3). Declared as a plain constant so
 * the handshake smoke test can assert the exact shape without spinning the
 * transport. `gocode_notify`'s schema mirrors the documented args
 * `{ kind?, title, body?, project? }`; only `title` is required.
 */
export const TOOLS: readonly Tool[] = [
  {
    name: NOTIFY_TOOL,
    description:
      "Send a push notification to the user's phone via the GoCode app. Call " +
      "this ONLY when the user has EXPLICITLY asked to be pinged when something " +
      "finishes (e.g. \"text me when the build is done\"). Routine end-of-turn " +
      "notifications are delivered automatically by client hooks — do NOT call " +
      "this for those, or the user gets double-pinged.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...NOTIFY_KINDS],
          description: 'Notification kind. Defaults to "finished".',
        },
        title: {
          type: "string",
          description: "Short notification title (required).",
        },
        body: { type: "string", description: "Optional longer body text." },
        project: {
          type: "string",
          description: "Optional project name shown for context.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: STATUS_TOOL,
    description:
      "Report whether GoCode credentials are present and the notify server is " +
      "reachable. Use this to self-diagnose: if it reports NOT paired, tell the " +
      "user to run `gocode-notify login`.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

/** Injectable dependencies for the tool handlers (lets tests stub fetch/HOME). */
export interface McpDeps extends PathOpts {
  /** Injectable fetch (defaults to the global). */
  fetchImpl?: typeof fetch;
  /** Request timeout override in ms. */
  timeoutMs?: number;
  /** `--server` override (highest server-URL precedence). */
  serverFlag?: string;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Handle a `gocode_notify` tool call. Validates `title` (required) and `kind`
 * (defaults to `finished`, must be a canonical kind), then funnels through the
 * shared internal {@link send}. Unlike the fire-and-forget hook path, an
 * on-demand agent ping does NOT queue to the offline outbox — a stale push
 * surfacing later would confuse the user; instead a failure is reported back so
 * the agent can tell the user to re-pair.
 */
export async function handleNotify(
  args: Record<string, unknown> | undefined,
  deps: McpDeps = {},
): Promise<CallToolResult> {
  const a = args ?? {};

  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (title === "") {
    return errorResult("gocode_notify: `title` is required.");
  }

  const kind = a.kind === undefined ? "finished" : a.kind;
  if (!isNotifyKind(kind)) {
    return errorResult(
      `gocode_notify: invalid kind "${String(a.kind)}" (expected one of: ${NOTIFY_KINDS.join(", ")}).`,
    );
  }

  const payload: SendPayload = { kind, title, source: "mcp" };
  if (typeof a.body === "string" && a.body !== "") payload.body = a.body;
  if (typeof a.project === "string" && a.project !== "") payload.project = a.project;

  const server = await resolveServerUrl(deps.serverFlag, deps);
  const sendOpts: SendOptions = {
    home: deps.home,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    server,
  };

  const result = await send(payload, sendOpts);
  if (result.ok) {
    const where =
      typeof result.sent === "number"
        ? ` (delivered to ${result.sent} device${result.sent === 1 ? "" : "s"})`
        : "";
    return textResult(`Sent ${payload.kind} notification "${title}"${where}.`);
  }
  return errorResult(
    `Could not send notification: ${result.error}. ` +
      "If this machine is not paired, ask the user to run `gocode-notify login`.",
  );
}

/**
 * Handle a `gocode_notify_status` tool call (no args). Returns a short report of
 * credential presence + server reachability so the agent can self-diagnose.
 * `isError` is set when not paired OR unreachable, so the agent surfaces the
 * problem rather than silently assuming notifications will arrive.
 */
export async function handleStatus(deps: McpDeps = {}): Promise<CallToolResult> {
  const report = await gatherStatus({
    home: deps.home,
    serverFlag: deps.serverFlag,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });

  const c = report.credentials;
  const lines: string[] = [];
  if (c.present) lines.push(`Credentials: paired as ${c.user_id} (${c.label}).`);
  else if (c.error) lines.push(`Credentials: unreadable — ${c.error}.`);
  else lines.push("Credentials: NOT paired — run `gocode-notify login`.");
  lines.push(
    `Server: ${report.server.url} — ${report.server.reachable ? "reachable" : "unreachable"} (${report.server.detail}).`,
  );

  const ok = c.present && report.server.reachable;
  return { content: [{ type: "text", text: lines.join("\n") }], isError: !ok };
}

/**
 * Build the MCP {@link Server} with the two tools registered. Pure (does not
 * touch the network or connect a transport) so the handshake smoke test can
 * drive it over an in-memory transport.
 */
export function createMcpServer(deps: McpDeps = {}): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: VERSION,
      // SEP-973 server metadata: icons + website for client UIs that support it
      // (MCP Inspector now; more clients over time). Ignored by clients that
      // don't read them.
      icons: [...SERVER_ICONS],
      websiteUrl: SERVER_WEBSITE_URL,
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === NOTIFY_TOOL) {
      return handleNotify(args as Record<string, unknown> | undefined, deps);
    }
    if (name === STATUS_TOOL) {
      return handleStatus(deps);
    }
    return errorResult(`Unknown tool: ${name}`);
  });

  return server;
}

/**
 * Run the MCP server over stdio until the client disconnects (stdin EOF). The
 * returned promise resolves only once the connection closes, so the CLI bin
 * stays alive for the lifetime of the session instead of exiting immediately
 * after the handshake.
 */
export async function serveStdio(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
}
