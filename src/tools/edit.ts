/**
 * edit_file — search-and-replace edit, reusing the M2 diff machinery.
 *
 * The user sees a colourised diff before the permission prompt, so they
 * can verify exactly what's about to change. Backed by `computeUpdatedContent`
 * (search exact -> whitespace-normalised fallback) so LLM indentation drift
 * doesn't break the edit.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { computeUpdatedContent, validateAppliedContent, validateSearchReplace } from "../diff.js";
import { renderUnifiedDiff } from "../render.js";
import type { ToolResult } from "./registry.js";
import type { PermissionStore } from "../permissions.js";

export interface EditFileArgs {
  path: string;
  old:  string;
  new:  string;
}

function permissionKey(absPath: string): string {
  const rel = relative(process.cwd(), absPath);
  const parts = rel.split(/[\\/]/);
  return parts.length > 1 ? `${parts[0]}/` : "<root>";
}

export async function editFile(args: EditFileArgs, perms: PermissionStore): Promise<ToolResult> {
  if (!args.path || typeof args.path !== "string") {
    return { ok: false, error: "edit_file: 'path' is required" };
  }
  if (typeof args.old !== "string" || typeof args.new !== "string") {
    return { ok: false, error: "edit_file: 'old' and 'new' must be strings" };
  }

  const abs = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
  let original: string;
  try {
    original = await fs.readFile(abs, "utf-8");
  } catch (err) {
    return { ok: false, error: `edit_file: cannot read ${abs}: ${(err as Error).message}` };
  }

  const v = validateSearchReplace({ filePath: abs, search: args.old, replace: args.new });
  if (!v.valid) {
    return { ok: false, error: `edit_file: ${v.reason}` };
  }

  let updated: string;
  try {
    updated = computeUpdatedContent(original, { filePath: abs, search: args.old, replace: args.new });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const post = validateAppliedContent(original, updated);
  if (!post.valid) {
    return { ok: false, error: `edit_file: ${post.reason}` };
  }

  const diff = renderUnifiedDiff(original, updated, { filePath: relative(process.cwd(), abs) });

  const decision = await perms.request({
    tool:    "edit_file",
    key:     permissionKey(abs),
    summary: `edit ${relative(process.cwd(), abs)}`,
    detail:  diff,
  });
  if (decision === "deny") {
    return { ok: false, error: "edit_file: user denied permission" };
  }

  try {
    await fs.writeFile(abs, updated, "utf-8");
    return {
      ok:     true,
      result: `edited ${abs} (${original.length} -> ${updated.length} bytes)`,
    };
  } catch (err) {
    return { ok: false, error: `edit_file: write failed: ${(err as Error).message}` };
  }
}
