/**
 * read_file — return a slice of a file with 1-based line numbers.
 *
 * 32k char cap mirrors EditorContext's attachment cap (src/context.ts).
 * Offset/limit let the model fetch a window of a large file without
 * blowing context.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolResult } from "./registry.js";

const MAX_BYTES = 32_000;

export interface ReadFileArgs {
  path:    string;
  offset?: number;
  limit?:  number;
}

export async function readFile(args: ReadFileArgs): Promise<ToolResult> {
  if (!args.path || typeof args.path !== "string") {
    return { ok: false, error: "read_file: 'path' is required" };
  }
  const abs = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      return { ok: false, error: `read_file: '${abs}' is a directory (use ls instead)` };
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
