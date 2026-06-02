/**
 * read_file — return a slice of a file with 1-based line numbers.
 *
 * 32k char cap mirrors EditorContext's attachment cap (src/context.ts).
 * Offset/limit let the model fetch a window of a large file without
 * blowing context.
 */

import { promises as fs } from "node:fs";
import type { ToolResult } from "./registry.js";
import type { PermissionStore } from "../permissions.js";
import { guardRead } from "./workspace.js";

const MAX_BYTES = 32_000;
/** Refuse to slurp a file larger than this whole into memory (OOM guard). */
const MAX_READ_BYTES = 10 * 1024 * 1024;

export interface ReadFileArgs {
  path:    string;
  offset?: number;
  limit?:  number;
}

export async function readFile(args: ReadFileArgs, perms: PermissionStore): Promise<ToolResult> {
  if (!args.path || typeof args.path !== "string") {
    return { ok: false, error: "read_file: 'path' is required" };
  }
  // Confine to the workspace — escapes prompt (non-TTY denies).
  const guard = await guardRead(args.path, perms, "read_file");
  if (!guard.ok) return { ok: false, error: guard.error };
  const abs = guard.abs;
  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      return { ok: false, error: `read_file: '${abs}' is a directory (use ls instead)` };
    }
    if (stat.size > MAX_READ_BYTES) {
      return {
        ok: false,
        error: `read_file: '${abs}' is ${(stat.size / 1024 / 1024).toFixed(1)} MB — too large to read whole; ` +
          `pass offset+limit to page through it.`,
      };
    }
    let content = await fs.readFile(abs, "utf-8");
    let truncated = false;

    const lines = content.split("\n");
    const start = Math.max(0, (args.offset ?? 1) - 1);
    const end   = args.limit ? Math.min(lines.length, start + args.limit) : lines.length;
    const slice = lines.slice(start, end);

    let numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5, " ")}  ${l}`).join("\n");
    if (numbered.length > MAX_BYTES) {
      numbered = numbered.slice(0, MAX_BYTES) + "\n  … [truncated — file is larger than 32k chars; use offset+limit to page]";
      truncated = true;
    }

    return {
      ok:       true,
      result:   numbered,
      truncated,
    };
  } catch (err) {
    return { ok: false, error: `read_file: ${(err as Error).message}` };
  }
}
