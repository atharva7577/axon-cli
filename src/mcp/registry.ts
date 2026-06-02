/**
 * registry.ts — the local MCP server registry at `~/.axon/mcp.json`.
 *
 * Shape mirrors Claude Code's `mcpServers` map so a project's existing config is
 * familiar:
 *   { "mcpServers": { "<name>": { "command": "npx", "args": ["-y", "pkg"],
 *                                 "env": { "KEY": "val" }, "cwd": "…",
 *                                 "disabled": false } } }
 *
 * The file can hold secrets (env values), so writes are atomic + chmod 0600,
 * exactly like config.json. Server names are validated to a single safe path
 * segment so they can be embedded in tool names without escaping.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.js";

const NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface McpServerSpec {
  command:   string;
  args?:     string[];
  env?:      Record<string, string>;
  cwd?:      string;
  /** When true, the server is kept in the file but not spawned. */
  disabled?: boolean;
}

export interface McpRegistry {
  mcpServers: Record<string, McpServerSpec>;
}

export function isValidServerName(name: string): boolean {
  return NAME_RE.test(name);
}

export function registryPath(): string {
  return join(configDir(), "mcp.json");
}

/** Read the registry, tolerating a missing file. Throws only on malformed JSON. */
export function readMcpRegistry(): McpRegistry {
  const path = registryPath();
  if (!existsSync(path)) return { mcpServers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`mcp: ${path} is unreadable (${(err as Error).message}). Fix or delete it.`);
  }
  const servers = (parsed as { mcpServers?: Record<string, McpServerSpec> } | null)?.mcpServers;
  return { mcpServers: servers && typeof servers === "object" ? servers : {} };
}

/** Atomically persist the registry (tmp → rename) with 0600 perms. */
export function writeMcpRegistry(reg: McpRegistry): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = registryPath();
  const tmp  = `${path}.tmp`;
  const json = JSON.stringify(reg, null, 2) + "\n";
  writeFileSync(tmp, json, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* no-op on win32 */ }
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* no-op on win32 */ }
}

/** Add or replace a server. Throws on an invalid name. */
export function addServer(name: string, spec: McpServerSpec): McpRegistry {
  if (!isValidServerName(name)) {
    throw new Error(`invalid server name "${name}" — use letters, digits, - and _ only`);
  }
  if (!spec.command || typeof spec.command !== "string") {
    throw new Error("a server needs a command (e.g. npx, uvx, node)");
  }
  const reg = readMcpRegistry();
  reg.mcpServers[name] = spec;
  writeMcpRegistry(reg);
  return reg;
}

/** Remove a server. Returns true if it existed. */
export function removeServer(name: string): boolean {
  const reg = readMcpRegistry();
  if (!reg.mcpServers[name]) return false;
  delete reg.mcpServers[name];
  writeMcpRegistry(reg);
  return true;
}

export interface ListedServer extends McpServerSpec {
  name: string;
}

/** All servers as a flat, name-sorted list. */
export function listServers(): ListedServer[] {
  const reg = readMcpRegistry();
  return Object.entries(reg.mcpServers)
    .map(([name, spec]) => ({ name, ...spec }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Just the enabled servers (disabled !== true). */
export function enabledServers(): ListedServer[] {
  return listServers().filter((s) => s.disabled !== true);
}
