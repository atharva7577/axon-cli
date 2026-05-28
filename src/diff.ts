/**
 * diff.ts — apply `code_edit` responses from the AXON backend, ported from
 * vscode-extension/src/bridge/DiffApplier.ts.
 *
 * The VS Code original drives WorkspaceEdit / showErrorMessage / Uri.parse.
 * Here we use plain fs + relative-to-cwd path resolution and surface failures
 * by throwing — the REPL renders the message.
 *
 *   Strict semantic search-and-replace
 *   ──────────────────────────────────
 *   • The LLM supplies an exact `search` string AND a complete `replace`.
 *   • Pre-validate: reject `…` placeholders on either side.
 *   • Locate the search block in the file — first exact, then whitespace-
 *     normalised (handles indentation drift).
 *   • Post-validate: reject placeholders in the applied result.
 *   • Backup the original content into memory so the REPL can `/undo`.
 *
 *   Full-file write
 *   ───────────────
 *   • `newContent` + `explicit: true` only. The REPL sets explicit when the
 *     user accepts an edit interactively.
 */

import { existsSync, promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

// ─── Public types ────────────────────────────────────────────────────────────

export interface SearchReplaceEdit {
  filePath: string;
  search:   string;
  replace:  string;
}

export interface FullFileEdit {
  filePath:   string;
  newContent: string;
  explicit?:  boolean;
}

export type CodeEditPayload = SearchReplaceEdit | FullFileEdit;

export interface ValidationResult {
  valid:   boolean;
  reason?: string;
}

export interface AppliedEdit {
  filePath:    string;
  /** Original on-disk content captured BEFORE the write, for /undo. */
  originalContent: string;
  /** New file content as written. */
  updatedContent:  string;
  /** True iff the target file did not exist pre-apply. */
  wasNewFile:  boolean;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = ["...", "// rest of code", "/* rest of code */"];

export function validateSearchReplace(edit: SearchReplaceEdit): ValidationResult {
  if (edit.search.includes("...")) {
    return { valid: false, reason: 'search block contains "..." placeholder — incomplete patch rejected' };
  }
  if (edit.replace.includes("...")) {
    return { valid: false, reason: 'replace block contains "..." placeholder — incomplete patch rejected' };
  }
  return { valid: true };
}

export function validateAppliedContent(original: string, updated: string): ValidationResult {
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (updated.includes(pat) && !original.includes(pat)) {
      return { valid: false, reason: `applied content contains placeholder "${pat}" — return complete valid patch` };
    }
  }
  return { valid: true };
}

// ─── parseCodeEdit ───────────────────────────────────────────────────────────

export function parseCodeEdit(response: unknown): CodeEditPayload | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  if (r.type !== "code_edit") return null;

  if (typeof r.search === "string" && typeof r.replace === "string" && typeof r.filePath === "string") {
    return { filePath: r.filePath as string, search: r.search as string, replace: r.replace as string };
  }
  if (typeof r.newContent === "string" && typeof r.filePath === "string") {
    return { filePath: r.filePath as string, newContent: r.newContent as string };
  }
  return null;
}

/** Pull a code_edit object out of a buffered (non-stream) AXON response. */
export function extractCodeEditFromResponse(response: unknown): CodeEditPayload | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  if (r.code_edit) return parseCodeEdit({ type: "code_edit", ...r.code_edit as Record<string, unknown> });
  return null;
}

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the LLM-supplied filePath into an absolute path on the user's disk.
 * Relative paths are joined onto workspaceRoot (defaulting to cwd). Absolute
 * paths are used verbatim. A rough sanity check rejects nested file:// schemes.
 */
export function resolveFilePath(filePath: string, workspaceRoot?: string): string {
  const cleaned = filePath.replace(/^file:\/\//i, "").trim();
  const root = workspaceRoot ?? process.cwd();
  const abs  = isAbsolute(cleaned) ? cleaned : resolve(root, cleaned);
  if (/file:[/\\]/i.test(abs)) {
    throw new Error(`[diff] resolved path "${abs}" contains a nested file:// scheme — refusing to write.`);
  }
  return abs;
}

// ─── computeUpdated ──────────────────────────────────────────────────────────

/**
 * Pure: given the original file content and a search/replace edit, return the
 * new content (or throw on a search-block mismatch).
 *
 * Search strategy:
 *   1. CRLF-normalise both sides; find the exact occurrence.
 *   2. If not found, fall back to a whitespace-normalised line match
 *      (handles LLM indentation drift).
 */
export function computeUpdatedContent(originalSource: string, edit: SearchReplaceEdit): string {
  const normSource = originalSource.replace(/\r\n/g, "\n");
  const normSearch = edit.search.replace(/\r\n/g, "\n");
  const replace    = edit.replace.replace(/\r\n/g, "\n");

  const idx = normSource.indexOf(normSearch);
  if (idx !== -1) {
    return normSource.slice(0, idx) + replace + normSource.slice(idx + normSearch.length);
  }
  const normMatch = findNormalizedMatch(normSource, normSearch);
  if (!normMatch) {
    throw new Error(
      `[diff] search block did not match (exact + whitespace-normalised both failed). ` +
      `Search head:\n${edit.search.slice(0, 200)}${edit.search.length > 200 ? "…" : ""}`,
    );
  }
  return normSource.slice(0, normMatch.startChar) + replace + normSource.slice(normMatch.endChar);
}

function findNormalizedMatch(
  source: string,
  search: string,
): { startChar: number; endChar: number } | null {
  const srcLines = source.split("\n");
  const srcNonEmpty = srcLines
    .map((l, i) => ({ trimmed: l.trim(), origIdx: i }))
    .filter(({ trimmed }) => trimmed.length > 0);
  const searchTrimmed = search.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (searchTrimmed.length === 0 || srcNonEmpty.length < searchTrimmed.length) return null;

  for (let i = 0; i <= srcNonEmpty.length - searchTrimmed.length; i++) {
    let matched = true;
    for (let j = 0; j < searchTrimmed.length; j++) {
      if (srcNonEmpty[i + j]!.trimmed !== searchTrimmed[j]) { matched = false; break; }
    }
    if (!matched) continue;

    const firstLineIdx = srcNonEmpty[i]!.origIdx;
    const lastLineIdx  = srcNonEmpty[i + searchTrimmed.length - 1]!.origIdx;
    let startChar = 0;
    for (let k = 0; k < firstLineIdx; k++) startChar += srcLines[k]!.length + 1;
    let endChar = startChar;
    for (let k = firstLineIdx; k <= lastLineIdx; k++) endChar += srcLines[k]!.length + 1;
    return { startChar, endChar: Math.min(endChar, source.length) };
  }
  return null;
}

// ─── applyCodeEdit ───────────────────────────────────────────────────────────

/**
 * Apply a CodeEditPayload to disk.
 *
 * Returns the AppliedEdit with the original + updated content + whether the
 * file was new. The caller (REPL) keeps the AppliedEdit so `/undo` can revert
 * by writing originalContent back. If the file did not exist pre-apply, /undo
 * deletes it.
 *
 * Throws on validation failure, file-system error, or search-block mismatch.
 */
export async function applyCodeEdit(
  payload: CodeEditPayload,
  workspaceRoot?: string,
): Promise<AppliedEdit> {
  if (!payload.filePath || payload.filePath.trim() === "") {
    throw new Error("[diff] cannot apply edit: filePath is missing from the backend response.");
  }

  // Full-file path — only when caller explicitly requested it.
  if ("newContent" in payload) {
    if (!payload.explicit) {
      throw new Error("[diff] full-file overwrite blocked — must be explicitly requested.");
    }
    return writeFullFile(resolveFilePath(payload.filePath, workspaceRoot), payload.newContent);
  }

  // Search-replace path.
  const pre = validateSearchReplace(payload);
  if (!pre.valid) throw new Error(`[diff] ${pre.reason}`);

  const abs = resolveFilePath(payload.filePath, workspaceRoot);
  const exists = existsSync(abs);
  if (!exists) {
    throw new Error(`[diff] target file does not exist: ${abs}`);
  }
  const source  = await fs.readFile(abs, "utf-8");
  const updated = computeUpdatedContent(source, payload);

  const post = validateAppliedContent(source, updated);
  if (!post.valid) throw new Error(`[diff] ${post.reason}`);

  await fs.writeFile(abs, updated, "utf-8");
  return { filePath: abs, originalContent: source, updatedContent: updated, wasNewFile: false };
}

async function writeFullFile(abs: string, content: string): Promise<AppliedEdit> {
  const wasNewFile = !existsSync(abs);
  let originalContent = "";
  if (!wasNewFile) {
    originalContent = await fs.readFile(abs, "utf-8");
  } else {
    await fs.mkdir(dirname(abs), { recursive: true });
  }
  await fs.writeFile(abs, content, "utf-8");
  return { filePath: abs, originalContent, updatedContent: content, wasNewFile };
}

/**
 * Revert an AppliedEdit. For a regular write, restores the original content.
 * For a new-file write, deletes the file. Throws on fs errors.
 */
export async function revertAppliedEdit(applied: AppliedEdit): Promise<void> {
  if (applied.wasNewFile) {
    try { await fs.unlink(applied.filePath); } catch { /* already gone */ }
    return;
  }
  await fs.writeFile(applied.filePath, applied.originalContent, "utf-8");
}
