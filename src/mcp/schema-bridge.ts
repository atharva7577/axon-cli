/**
 * schema-bridge.ts — turn an MCP tool definition into a CLI ToolSchema.
 *
 * MCP tools advertise a name + description + JSON-Schema `inputSchema`. We expose
 * them to the model under a qualified, OpenAI-safe name `mcp__<server>__<tool>`
 * (so they can't collide with the 8 built-ins) and pass the input schema straight
 * through as the function parameters. The qualified name is also the dispatch key
 * the agent loop uses to route a call back to the owning MCP server.
 */

import type { ToolSchema } from "../tools/schemas.js";

/** OpenAI tool names must match ^[a-zA-Z0-9_-]+$ and be ≤64 chars. */
const MAX_TOOL_NAME = 64;
const MAX_DESC = 1024;

export function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Build `mcp__<server>__<tool>`, sanitized and length-capped. */
export function qualifiedToolName(server: string, tool: string): string {
  const name = `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
  return name.length > MAX_TOOL_NAME ? name.slice(0, MAX_TOOL_NAME) : name;
}

export interface McpToolDef {
  name:         string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Convert one MCP tool into a CLI ToolSchema registered under `qualifiedName`. */
export function mcpToolToSchema(qualifiedName: string, server: string, tool: McpToolDef): ToolSchema {
  const input      = (tool.inputSchema ?? {}) as { properties?: unknown; required?: unknown };
  const properties = (input.properties && typeof input.properties === "object")
    ? (input.properties as Record<string, unknown>)
    : {};
  const required = Array.isArray(input.required) ? (input.required as string[]) : undefined;
  const description = (tool.description ? `[${server}] ${tool.description}` : `[${server}] ${tool.name}`).slice(0, MAX_DESC);

  return {
    type: "function",
    function: {
      name: qualifiedName,
      description,
      parameters: {
        type: "object",
        properties,
        ...(required ? { required } : {}),
      },
    },
  };
}
