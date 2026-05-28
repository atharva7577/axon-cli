/**
 * render.ts — colourised unified-diff renderer for the REPL.
 *
 * Single entry point: `renderUnifiedDiff(original, updated, header?)`.
 * Uses jsdiff's `structuredPatch` to compute hunks then ANSI-colours each
 * line: red for removed, green for added, dim for context. Headers are
 * bold cyan.
 */

import chalk from "chalk";
import { structuredPatch, type StructuredPatchHunk } from "diff";

const CONTEXT_LINES = 3;

export function renderUnifiedDiff(
  original: string,
  updated:  string,
  header?:  { filePath?: string; subject?: string },
): string {
  const patch = structuredPatch(
    header?.filePath ?? "a",
    header?.filePath ?? "b",
    original,
    updated,
    "",
    "",
    { context: CONTEXT_LINES },
  );

  const lines: string[] = [];
  if (header?.filePath || header?.subject) {
    const title = header?.filePath ?? header?.subject ?? "";
    lines.push(chalk.bold.cyan(`──── ${title} ────`));
  }
  for (const hunk of patch.hunks) {
    lines.push(formatHunkHeader(hunk));
    for (const ln of hunk.lines) {
      const ch = ln[0];
      const body = ln.slice(1);
      if (ch === "+") lines.push(chalk.green(`+ ${body}`));
      else if (ch === "-") lines.push(chalk.red(`- ${body}`));
      else if (ch === "\\") lines.push(chalk.dim(`  ${body}`));
      else lines.push(chalk.dim(`  ${body}`));
    }
  }
  if (lines.length === 0) lines.push(chalk.dim("(no changes)"));
  return lines.join("\n");
}

function formatHunkHeader(hunk: StructuredPatchHunk): string {
  return chalk.cyan(
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  );
}

/**
 * Inline summary of a search/replace edit (no jsdiff dependency — used when
 * the edit is a search/replace block that hasn't been applied yet).
 */
export function renderSearchReplace(filePath: string, search: string, replace: string): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan(`──── ${filePath} ────`));
  for (const l of search.split("\n")) lines.push(chalk.red(`- ${l}`));
  for (const l of replace.split("\n")) lines.push(chalk.green(`+ ${l}`));
  return lines.join("\n");
}
