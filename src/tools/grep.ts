/**
 * grep — regex search over files matched by a glob.
 *
 * Pure-JS implementation (no rg dependency) so installs don't need ripgrep.
 * Caps: 100 matches, 50 files scanned, 1 MB per file. Plenty for the
 * "where is X defined" use case.
 */

import { promises as fsp } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolResult } from "./registry.js";
import type { PermissionStore } from "../permissions.js";
import { canonicalize, isInsideRoot } from "./workspace.js";
import { globFiles } from "./walk.js";

const MAX_MATCHES = 100;
const MAX_FILES = 50;
const MAX_FILE_BYTES = 1_000_000;

const DEFAULT_EXCLUDE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
];

export interface GrepArgs {
  pattern:           string;
  path_glob?:        string;
  case_insensitive?: boolean;
}

export async function grep(args: GrepArgs, _perms: PermissionStore): Promise<ToolResult> {
  if (!args.pattern || typeof args.pattern !== "string") {
    return { ok: false, error: "grep: 'pattern' is required" };
  }
  let re: RegExp;
  try {
    re = new RegExp(args.pattern, args.case_insensitive ? "gi" : "g");
  } catch (err) {
    return { ok: false, error: `grep: invalid regex — ${(err as Error).message}` };
  }

  const pattern = args.path_glob ?? "**/*";
  const cwd = process.cwd();
  const results: string[] = [];
  let scanned = 0;
  let truncated = false;

  try {
    const found = await globFiles(pattern, { cwd, excludeDirs: DEFAULT_EXCLUDE });

    for (const rel of found) {
      if (scanned >= MAX_FILES) { truncated = true; break; }
      if (results.length >= MAX_MATCHES) { truncated = true; break; }
      const abs = isAbsolute(rel) ? rel : resolve(cwd, rel);
      // grep READS file contents, so confine by the canonical path (defeats a
      // `../../**` pattern and any in-repo symlink that points outside the root).
      if (!isInsideRoot(canonicalize(abs))) continue;
      try {
        const stat = await fsp.stat(abs);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fsp.readFile(abs, "utf-8");
        scanned++;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            results.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
            if (results.length >= MAX_MATCHES) { truncated = true; break; }
          }
          re.lastIndex = 0;
        }
      } catch {
        // skip unreadable files (binary, permission denied, etc.)
      }
    }

    return {
      ok:       true,
      result:   results.length > 0
        ? `${results.length} match${results.length === 1 ? "" : "es"} in ${scanned} file${scanned === 1 ? "" : "s"}:\n${results.join("\n")}`
        : `(no matches across ${scanned} file${scanned === 1 ? "" : "s"})`,
      truncated,
    };
  } catch (err) {
    return { ok: false, error: `grep: ${(err as Error).message}` };
  }
}
