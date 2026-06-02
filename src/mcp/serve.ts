/**
 * serve.ts — `axon mcp serve`: expose AXON's own MCP tools over stdio.
 *
 * A thin protocol-level proxy: it connects (as a client) to the AXON backend's
 * `POST /mcp` Streamable-HTTP endpoint with the tenant's Bearer key, then serves
 * a local stdio MCP server that forwards `tools/list` and `tools/call` straight
 * upstream. So a stdio MCP host (Claude Desktop, etc.) configured with
 * `command: "axon", args: ["mcp", "serve"]` gets route_for_intent /
 * get_edit_pattern / query_workspace_memory — whatever the backend exposes —
 * with zero reimplementation. Schemas pass through verbatim (no zod round-trip).
 *
 * Blocks until stdin closes so index.ts's post-command process.exit() can't kill
 * it mid-session.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readConfig } from "../config.js";
import { assertSecureBase } from "../http.js";

export async function runMcpServe(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    throw new Error("axon mcp serve: not logged in — run `axon login` first.");
  }
  const apiBase = cfg.apiBase.replace(/\/+$/, "");
  assertSecureBase(apiBase); // bearer key must not travel in clear text (localhost exempt)

  // Upstream: client → backend /mcp (Streamable HTTP, Bearer auth).
  const upstream = new Client({ name: "axon-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
  const upstreamTransport = new StreamableHTTPClientTransport(new URL(`${apiBase}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
  });
  await upstream.connect(upstreamTransport);

  // Local: stdio server that proxies every tool call upstream.
  const server = new Server({ name: "axon", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const reply = await upstream.listTools();
    return { tools: reply.tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await upstream.callTool(req.params);
  });

  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  // Hold the process open until the stdio peer disconnects.
  await new Promise<void>((resolve) => {
    stdio.onclose = () => resolve();
    process.stdin.once("close", resolve);
    process.stdin.once("end", resolve);
  });

  await upstream.close().catch(() => undefined);
}
