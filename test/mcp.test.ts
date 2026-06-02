/**
 * MCP registry (src/mcp/registry.ts) + schema bridge (src/mcp/schema-bridge.ts).
 * Covers CRUD + atomic write, name validation (no traversal), the enabled
 * filter, OpenAI-safe qualified tool names, and inputSchema → ToolSchema mapping.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { tmpTree, cleanupAll, withConfigDir } from "./helpers.js";
import {
  addServer, removeServer, listServers, enabledServers, isValidServerName, registryPath,
} from "../src/mcp/registry.js";
import { qualifiedToolName, mcpToolToSchema } from "../src/mcp/schema-bridge.js";

afterEach(() => cleanupAll());

describe("mcp registry", () => {
  it("add → list → remove round-trips, sorted, atomic (no .tmp)", () => {
    const restore = withConfigDir(tmpTree());
    try {
      addServer("tp", { command: "npx", args: ["-y", "pkg"] });
      addServer("db", { command: "node", args: ["s.js"], env: { K: "v" }, disabled: true });

      expect(listServers().map((s) => s.name)).toEqual(["db", "tp"]); // name-sorted
      expect(enabledServers().map((s) => s.name)).toEqual(["tp"]);    // db disabled

      expect(removeServer("tp")).toBe(true);
      expect(removeServer("tp")).toBe(false);
      expect(listServers().map((s) => s.name)).toEqual(["db"]);
      expect(existsSync(registryPath() + ".tmp")).toBe(false);
    } finally {
      restore();
    }
  });

  it("rejects invalid server names (no traversal / spaces)", () => {
    expect(isValidServerName("ok-name_1")).toBe(true);
    expect(isValidServerName("../x")).toBe(false);
    expect(isValidServerName("a b")).toBe(false);
    const restore = withConfigDir(tmpTree());
    try {
      expect(() => addServer("bad/name", { command: "x" })).toThrow(/invalid/i);
    } finally {
      restore();
    }
  });

  it("addServer requires a command", () => {
    const restore = withConfigDir(tmpTree());
    try {
      expect(() => addServer("x", { command: "" })).toThrow(/command/i);
    } finally {
      restore();
    }
  });
});

describe("schema-bridge", () => {
  it("qualifiedToolName is sanitized and length-capped", () => {
    expect(qualifiedToolName("tp", "think")).toBe("mcp__tp__think");
    expect(qualifiedToolName("my.server", "do:it")).toBe("mcp__my_server__do_it");
    expect(qualifiedToolName("s", "x".repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it("maps inputSchema and prefixes the description with the server", () => {
    const s = mcpToolToSchema("mcp__tp__think", "tp", {
      name: "think",
      description: "Think.",
      inputSchema: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] },
    });
    expect(s.function.name).toBe("mcp__tp__think");
    expect(s.function.description).toBe("[tp] Think.");
    expect(s.function.parameters.properties).toHaveProperty("thought");
    expect(s.function.parameters.required).toEqual(["thought"]);
  });

  it("tolerates a tool with no inputSchema", () => {
    const s = mcpToolToSchema("mcp__tp__noargs", "tp", { name: "noargs" });
    expect(s.function.parameters.properties).toEqual({});
    expect(s.function.parameters.required).toBeUndefined();
    expect(s.function.description).toBe("[tp] noargs");
  });
});
