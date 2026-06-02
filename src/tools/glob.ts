/**
 * glob — find files matching a pattern, newest-modified first.
 *
 * Uses Node 22+ `fs.glob`. Cap at 200 paths so the model can't pull in
 * a 10k-file repo in one shot.
 */

import { glob as fspGlob } from "node:fs/promises";
import { promises as fsp } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolResult } from "./registry.js";
import type { PermissionStore } from "../permissions.js";
import { guardRead, isInsideRoot, workspaceRoot } from "./workspace.js";

const MAX_RESULTS = 200;

const DEFAULT_EXCLUDE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
];

export interface GlobArgs {
  pattern: string;
  cwd?:    string;
}

export async function glob(args: GlobArgs, perms: PermissionStore): Promise<ToolResult> {
  if (!args.pattern || typeof args.pattern !== "string") {
    return { ok: false, error: "glob: 'pattern' is required" };
  }
  // Confine the search base. Inside root → silent; an explicit out-of-root `cwd`
  // prompts (non-TTY denies). When the base is inside the repo we filter results
  // back to the repo root so a `../../**` pattern can't leak outside files.
  const guard = await guardRead(args.cwd ?? process.cwd(), perms, "glob");
  if (!guard.ok) return { ok: false, error: guard.error };
  const cwd = guard.abs;
  const effectiveRoot = isInsideRoot(cwd) ? workspaceRoot() : cwd;

  try {
    let outsideDropped = 0;
    const matches: string[] = [];
    // fs/promises.glob is async iterable in Node 22+.
    const iter = fspGlob(args.pattern, {
      cwd,
      exclude: (p: string) => DEFAULT_EXCLUDE.some((d) => p.includes(`/${d}/`) || p.startsWith(`${d}/`) || p === d),
    } as Parameters<typeof fspGlob>[1]);
    for await (const m of iter) {
      const rel = m as string;
      const abs = isAbsolute(rel) ? rel : resolve(cwd, rel);
      if (!isInsideRoot(abs, effectiveRoot)) { outsideDropped++; continue; }
      matches.push(rel);
      if (matches.length >= MAX_RESULTS * 2) break;
    }

    // Sort by mtime desc when feasible (best-effort; skip stat failures).
    const stamped = await Promise.all(
      matches.map(async (m) => {
        try {
          const abs = isAbsolute(m) ? m : resolve(cwd, m);
          const s = await fsp.stat(abs);
          return { path: m, mtime: s.mtimeMs };
        } catch {
          return { path: m, mtime: 0 };
        }
      }),
    );
    stamped.sort((a, b) => b.mtime - a.mtime);

    const truncated = stamped.length > MAX_RESULTS;
    const out = stamped.slice(0, MAX_RESULTS).map((s) => s.path).join("\n") || "(no matches)";
    const note = outsideDropped > 0
      ? `\n(${outsideDropped} match${outsideDropped === 1 ? "" : "es"} outside the workspace omitted)`
      : "";
    return {
      ok:       true,
      result:   `cwd: ${cwd}\n${out}${note}`,
      truncated,
    };
  } catch (err) {
    return { ok: false, error: `glob: ${(err as Error).message}` };
  }
}
