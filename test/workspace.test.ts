/**
 * Filesystem confinement (src/tools/workspace.ts). The agent's file tools must
 * operate freely inside the workspace root but treat any `..`/symlink escape as
 * out-of-bounds — silently for reads inside the repo, gated for reads outside.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import {
  tmpTree, cleanupAll, makeGitRoot, ensureDir, writeFileDeep, canSymlink, makeSymlink,
} from "./helpers.js";
import {
  workspaceRoot, canonicalize, isInsideRoot, classifyWrite, guardRead, _resetWorkspaceRootCache,
} from "../src/tools/workspace.js";
import { PermissionStore } from "../src/permissions.js";

const origCwd = process.cwd();

afterEach(() => {
  process.chdir(origCwd);
  _resetWorkspaceRootCache();
  cleanupAll();
});

function enterRepo(): string {
  const repo = tmpTree();
  makeGitRoot(repo);
  process.chdir(repo);
  _resetWorkspaceRootCache();
  return repo;
}

describe("workspaceRoot", () => {
  it("resolves to the git repo root from a nested cwd", () => {
    const repo = tmpTree();
    makeGitRoot(repo);
    const sub = join(repo, "a", "b");
    ensureDir(sub);
    process.chdir(sub);
    _resetWorkspaceRootCache();
    expect(workspaceRoot()).toBe(canonicalize(repo));
  });
});

describe("isInsideRoot / classifyWrite", () => {
  it("inside-repo paths are inside; escapes are not", () => {
    const repo = enterRepo();
    expect(isInsideRoot(canonicalize("src/a.ts"))).toBe(true);
    expect(isInsideRoot(canonicalize(repo))).toBe(true);
    expect(isInsideRoot(canonicalize("../sibling/x"))).toBe(false);
    expect(isInsideRoot(canonicalize(join(repo, "..", "x")))).toBe(false);
  });

  it("classifyWrite flags out-of-root targets", () => {
    enterRepo();
    expect(classifyWrite("src/new.ts").outside).toBe(false);
    expect(classifyWrite("../escape.ts").outside).toBe(true);
  });
});

describe("guardRead", () => {
  it("allows reads inside the repo without prompting", async () => {
    enterRepo();
    const r = await guardRead("README.md", new PermissionStore(), "read_file");
    expect(r.ok).toBe(true);
  });

  it("denies a `..` escape under a non-TTY session", async () => {
    enterRepo();
    const r = await guardRead("../../secret", new PermissionStore(), "read_file");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outside the workspace/i);
  });
});

describe("canonicalize (symlink escapes)", () => {
  it("follows an in-repo symlink to its real out-of-repo target", () => {
    if (!canSymlink()) return; // platform can't create symlinks — skip
    const repo = enterRepo();
    const outside = tmpTree();
    const secret = join(outside, "secret.txt");
    writeFileDeep(secret, "top secret");
    makeSymlink(secret, join(repo, "link.txt"));
    expect(isInsideRoot(canonicalize("link.txt"))).toBe(false);
  });
});
