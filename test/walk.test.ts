/**
 * globFiles — the Node 20–compatible glob walker that replaced Node 22's
 * `fs/promises#glob` (whose static import crashed `axon` at link time on Node
 * 20). Guards the matching, pruning, symlink-safety, and path-shape contract
 * the glob/grep tools depend on.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import {
  tmpTree, cleanupAll, writeFileDeep, ensureDir, canSymlink, makeSymlink, norm,
} from "./helpers.js";
import { globFiles } from "../src/tools/walk.js";

const EXCLUDE = ["node_modules", ".git", "dist"];

afterEach(cleanupAll);

function fixture(): string {
  const root = tmpTree();
  writeFileDeep(join(root, "a.ts"), "export const a = 1;");
  writeFileDeep(join(root, "src", "b.ts"), "export const b = 2;");
  writeFileDeep(join(root, "src", "nested", "c.ts"), "export const c = 3;");
  writeFileDeep(join(root, "README.md"), "# readme");
  writeFileDeep(join(root, "data.json"), "{}");
  writeFileDeep(join(root, "node_modules", "dep", "index.ts"), "module.exports={}");
  writeFileDeep(join(root, ".git", "config"), "[core]");
  return root;
}

describe("globFiles", () => {
  it("matches **/*.ts at any depth and skips other extensions", async () => {
    const root = fixture();
    const found = (await globFiles("**/*.ts", { cwd: root, excludeDirs: EXCLUDE })).map(norm);
    expect(found.sort()).toEqual(["a.ts", "src/b.ts", "src/nested/c.ts"]);
  });

  it("honors a scoped prefix pattern (src/**/*.ts)", async () => {
    const root = fixture();
    const found = (await globFiles("src/**/*.ts", { cwd: root, excludeDirs: EXCLUDE })).map(norm);
    expect(found.sort()).toEqual(["src/b.ts", "src/nested/c.ts"]);
  });

  it("supports brace alternation (**/*.{md,json})", async () => {
    const root = fixture();
    const found = (await globFiles("**/*.{md,json}", { cwd: root, excludeDirs: EXCLUDE })).map(norm);
    expect(found.sort()).toEqual(["README.md", "data.json"]);
  });

  it("prunes excluded directories (never descends node_modules/.git)", async () => {
    const root = fixture();
    const found = (await globFiles("**/*", { cwd: root, excludeDirs: EXCLUDE })).map(norm);
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
    expect(found.some((p) => p.startsWith(".git/"))).toBe(false);
  });

  it("returns POSIX-separator relative paths regardless of platform", async () => {
    const root = fixture();
    const found = await globFiles("src/**/*.ts", { cwd: root, excludeDirs: EXCLUDE });
    expect(found.every((p) => !p.includes("\\"))).toBe(true);
  });

  it("never follows symlinked directories", async () => {
    if (!canSymlink()) return; // Windows without privilege — skip
    const root = fixture();
    const outside = tmpTree();
    writeFileDeep(join(outside, "secret.ts"), "export const secret = 1;");
    ensureDir(join(root, "src"));
    try {
      makeSymlink(outside, join(root, "src", "linked"));
    } catch {
      return; // dir-symlink creation not permitted here — skip
    }
    const found = (await globFiles("**/*.ts", { cwd: root, excludeDirs: EXCLUDE })).map(norm);
    expect(found.some((p) => p.includes("linked"))).toBe(false);
    expect(found.some((p) => p.includes("secret"))).toBe(false);
  });

  it("caps emitted paths at `max`", async () => {
    const root = tmpTree();
    for (let i = 0; i < 20; i++) writeFileDeep(join(root, `f${i}.ts`), "x");
    const found = await globFiles("**/*.ts", { cwd: root, excludeDirs: EXCLUDE, max: 5 });
    expect(found.length).toBe(5);
  });
});
