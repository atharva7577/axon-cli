/**
 * client.ts — McpClientPool: spawn the configured MCP servers, aggregate their
 * tools, and dispatch calls back to the owning server.
 *
 * One stdio subprocess per enabled server, alive for the session. The SDK's
 * StdioClientTransport uses cross-spawn (so `npx`/`uvx` resolve to `.cmd` on
 * Windows) and merges a safe default environment (PATH/APPDATA/SYSTEMROOT/…),
 * so we only pass the server's own command/args/env/cwd. A server that fails to
 * spawn or list tools is warned about and skipped — it never blocks the others.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSchema } from "../tools/schemas.js";
import type { ToolResult } from "../tools/registry.js";
import { enabledServers, type ListedServer } from "./registry.js";
import { mcpToolToSchema, qualifiedToolName, type McpToolDef } from "./schema-bridge.js";

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS    = 60_000;

interface ToolRef { server: string; rawName: string; }

export class McpClientPool {
  private clients  = new Map<string, Client>();
  private toolMap  = new Map<string, ToolRef>(); // qualified name → owning server + raw tool
  private schemaList: ToolSchema[] = [];

  constructor(private readonly servers: ListedServer[]) {}

  get serverCount(): number { return this.clients.size; }
  get toolCount():   number { return this.toolMap.size; }

  /** Spawn every enabled server and collect its tools. Best-effort per server. */
  async start(opts: { onWarn?: (msg: string) => void } = {}): Promise<void> {
    const warn = opts.onWarn ?? (() => {});
    const used = new Set<string>();

    for (const spec of this.servers) {
      if (spec.disabled) continue;

      let client: Client;
      try {
        client = await this.spawn(spec);
      } catch (err) {
        warn(`MCP "${spec.name}" failed to start: ${(err as Error).message}`);
        continue;
      }

      let tools: McpToolDef[];
      try {
        const reply = await withTimeout(client.listTools(), CALL_TIMEOUT_MS, `${spec.name} tools/list`);
        tools = (reply.tools ?? []) as unknown as McpToolDef[];
      } catch (err) {
        warn(`MCP "${spec.name}" tools/list failed: ${(err as Error).message}`);
        await client.close().catch(() => undefined);
        continue;
      }

      this.clients.set(spec.name, client);
      for (const t of tools) {
        const qn = uniqueName(qualifiedToolName(spec.name, t.name), used);
        used.add(qn);
        this.toolMap.set(qn, { server: spec.name, rawName: t.name });
        this.schemaList.push(mcpToolToSchema(qn, spec.name, t));
      }
    }
  }

  private async spawn(spec: ListedServer): Promise<Client> {
    const transport = new StdioClientTransport({
      command: spec.command,
      args:    spec.args ?? [],
      env:     spec.env,   // SDK merges getDefaultEnvironment() (PATH/APPDATA/…)
      cwd:     spec.cwd,
    });
    const client = new Client({ name: "axon-cli", version: "0.1.0" }, { capabilities: {} });
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${spec.name}`);
    return client;
  }

  schemas(): ToolSchema[]                 { return this.schemaList; }
  owns(name: string): boolean             { return this.toolMap.has(name); }
  serverOf(name: string): string | undefined { return this.toolMap.get(name)?.server; }

  /** Dispatch a qualified MCP tool call and flatten the result content to text. */
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const ref = this.toolMap.get(qualifiedName);
    if (!ref) return { ok: false, error: `unknown MCP tool: ${qualifiedName}` };
    const client = this.clients.get(ref.server);
    if (!client) return { ok: false, error: `MCP server not running: ${ref.server}` };

    try {
      const res = await withTimeout(
        client.callTool({ name: ref.rawName, arguments: args }),
        CALL_TIMEOUT_MS,
        `tools/call ${qualifiedName}`,
      ) as { content?: unknown; isError?: boolean };
      const text = flattenContent(res.content);
      return res.isError
        ? { ok: false, error: text || "MCP tool reported an error" }
        : { ok: true, result: text };
    } catch (err) {
      return { ok: false, error: `MCP call failed: ${(err as Error).message}` };
    }
  }

  async stop(): Promise<void> {
    const closes = [...this.clients.values()].map((c) => c.close().catch(() => undefined));
    this.clients.clear();
    this.toolMap.clear();
    this.schemaList = [];
    await Promise.allSettled(closes);
  }
}

/**
 * Start a pool from the enabled servers in `~/.axon/mcp.json`, or null when none
 * are configured (so callers can no-op cheaply). Best-effort: a broken server is
 * warned about and skipped.
 */
export async function startMcpPool(onWarn?: (msg: string) => void): Promise<McpClientPool | null> {
  const servers = enabledServers();
  if (servers.length === 0) return null;
  const pool = new McpClientPool(servers);
  await pool.start({ onWarn });
  return pool;
}

/** Make `name` unique within `used` by appending _2, _3, … (length-safe). */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const cand = (name.length + suffix.length > 64 ? name.slice(0, 64 - suffix.length) : name) + suffix;
    if (!used.has(cand)) return cand;
  }
}

/** Flatten an MCP result `content[]` into a single text blob. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const parts: string[] = [];
  for (const item of content) {
    const it = item as { type?: string; text?: string } | null;
    if (it && it.type === "text" && typeof it.text === "string") parts.push(it.text);
    else parts.push(JSON.stringify(item));
  }
  return parts.join("\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let to: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    to = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => { if (to) clearTimeout(to); }) as Promise<T>;
}
