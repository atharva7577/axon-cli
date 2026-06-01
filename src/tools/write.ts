/**
 * write_file — create or overwrite a file with the supplied content.
 *
 * Parent dirs created automatically. Permission-gated by parent-directory
 * key so "always allow writes under src/" matches every src/** write.
 */

import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ToolResult } from "./registry.js";
import type { PermissionStore } from "../permissions.js";
import { filePermissionKey } from "./permKey.js";

const MAX_BYTES = 1_000_000;

export interface WriteFileArgs {
  path:    string;
  content: string;
}

export async function writeFile(args: WriteFileArgs, perms: PermissionStore): Promise<ToolResult> {
  if (!args.path || typeof args.path !== "string") {
    return { ok: false, error: "write_file: 'path' is required" };
  }
  if (typeof args.content !== "string") {
    return { ok: false, error: "write_file: 'content' must be a string" };
  }
  if (args.content.length > MAX_BYTES) {
    return { ok: false, error: `write_file: content exceeds ${MAX_BYTES} bytes — split into multiple calls or use edit_file` };
  }

  const abs = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
  const key = filePermissionKey(abs);

  let exists = false;
  try { await fs.access(abs); exists = true; } catch { exists = false; }
  const verb = exists ? "overwrite" : "create";
  const sizeKB = (args.content.length / 1024).toFixed(1);

  const decision = await perms.request({
    tool:    "write_file",
    key,
    summary: `${verb} ${relative(process.cwd(), abs)}  (${sizeKB} KB)`,
  });
  if (decision === "deny") {
    return { ok: false, error: "write_file: user denied permission" };
  }

  try {
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, args.content, "utf-8");
    return {
      ok:     true,
      result: `${verb}d ${abs} (${args.content.length} bytes)`,
    };
  } catch (err) {
    return { ok: false, error: `write_file: ${(err as Error).message}` };
  }
}
