/**
 * rg — the `grep` tool's executor: ripgrep when available, pure-JS grep
 * fallback otherwise. These assert the result CONTRACT, which must hold
 * identically whichever engine runs (so CI passes with or without rg on PATH).
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { join } from "node:path";
import { tmpTree, cleanupAll, writeFileDeep } from "./helpers.js";
import { rg } from "../src/tools/rg.js";
import { _resetWorkspaceRootCache } from "../src/tools/workspace.js";
import type { PermissionStore } from "../src/permissions.js";

// rg/grep read paths never call the permission gate — a stub is never invoked.
const perms = {} as unknown as PermissionStore;

let prevCwd: string;

beforeEach(() => { prevCwd = process.cwd(); _resetWorkspaceRootCache(); });
afterEach(() => { process.chdir(prevCwd); _resetWorkspaceRootCache(); cleanupAll(); });

function fixture(): string {
  const root = tmpTree();
  writeFileDeep(join(root, "a.ts"), "export const needle = 1;\nconst other = 2;");
  writeFileDeep(join(root, "src", "b.ts"), "// needle lives here too");
  writeFileDeep(join(root, "src", "c.ts"), "export const unrelated = 3;");
  return root;
}

describe("rg (ripgrep search with JS fallback)", () => {
  it("finds a pattern across files", async () => {
    process.chdir(fixture());
    const res = await rg({ pattern: "needle" }, perms);
    expect(res.ok).toBe(true);
    expect(res.result).toContain("a.ts");
    expect(res.result?.toLowerCase()).toContain("needle");
  });

  it("honors a path_glob filter", async () => {
    process.chdir(fixture());
    const res = await rg({ pattern: "needle", path_glob: "src/**/*.ts" }, perms);
    expect(res.ok).toBe(true);
    expect(res.result).toContain("b.ts");      // src/b.ts has needle
    expect(res.result).not.toContain("a.ts:"); // root a.ts excluded by the glob
  });

  it("returns a clean no-match result (not an error)", async () => {
    process.chdir(fixture());
    const res = await rg({ pattern: "zzz_absent_token_zzz" }, perms);
    expect(res.ok).toBe(true);
    expect(res.result?.toLowerCase()).toMatch(/no match/);
  });

  it("rejects an empty pattern", async () => {
    const res = await rg({ pattern: "" }, perms);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/required/);
  });
});
