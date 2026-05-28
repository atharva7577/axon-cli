/**
 * ls — list a directory with [d]/[f] markers + byte sizes.
 *
 * Mirrors `dir` / `ls -la` minimal output. Hidden files (leading dot) are
 * included unless excluded by the default block list.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolResult } from "./registry.js";

const DEFAULT_EXCLUDE = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".cache",
]);

export interface LsArgs {
  path?: string;
}

export async function ls(args: LsArgs): Promise<ToolResult> {
  const target = args.path
    ? (isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path))
    : process.cwd();

  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const rows: string[] = [];
    for (const e of entries) {
      if (DEFAULT_EXCLUDE.has(e.name)) continue;
      if (e.isDirectory()) {
        rows.push(`[d] ${e.name}/`);
      } else if (e.isFile()) {
        try {
          const s = await fs.stat(resolve(target, e.name));
          rows.push(`[f] ${e.name}  (${s.size}B)`);
        } catch {
          rows.push(`[f] ${e.name}`);
        }
      } else {
        rows.push(`[?] ${e.name}`);
      }
    }
    rows.sort((a, b) => a.localeCompare(b));
    return {
      ok:     true,
      result: rows.length > 0 ? `${target}:\n${rows.join("\n")}` : `(empty: ${target})`,
    };
  } catch (err) {
    return { ok: false, error: `ls: ${(err as Error).message}` };
  }
}
