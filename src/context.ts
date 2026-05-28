/**
 * context.ts — terminal-side analogue of the VS Code EditorContext.
 *
 * The VS Code original pulls activeEditor + selection + diagnostics from
 * the IDE. The CLI has no editor — instead the user attaches files
 * explicitly via `/file <path>` (and later `/files <glob>`). This module
 * tracks the attached set and builds the BackendContext the chat call
 * sends as `context: {...}`.
 *
 * Hard cap mirrors the original: 32k chars total across attached files,
 * after which the next file is rejected with a clear error.
 */

import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

export const MAX_CONTEXT_CHARS = 32_000;

export interface AttachedFile {
  /** Absolute path on disk. */
  path:     string;
  /** Path the model sees — relative to workspaceRoot when possible. */
  relPath:  string;
  content:  string;
  bytes:    number;
  language: string;
}

/** What the chat call sends as the request body's `context` field. */
export interface ChatContext {
  workspacePath: string;
  activeFile?:   { path: string; content: string; language: string };
  recentFiles?:  string[];
}

/** Compute total char count across attached files. */
export function totalChars(files: Iterable<AttachedFile>): number {
  let n = 0;
  for (const f of files) n += f.content.length;
  return n;
}

export class AttachedFiles {
  private readonly files = new Map<string, AttachedFile>();

  constructor(public readonly workspaceRoot: string = process.cwd()) {}

  list(): AttachedFile[] {
    return [...this.files.values()];
  }

  size(): number { return this.files.size; }

  clear(): void { this.files.clear(); }

  has(absPath: string): boolean { return this.files.has(absPath); }

  /**
   * Read the file from disk and add it to the set. Returns the AttachedFile.
   * Throws on FS error or when adding the file would exceed MAX_CONTEXT_CHARS.
   */
  async add(rawPath: string): Promise<AttachedFile> {
    const abs = isAbsolute(rawPath) ? rawPath : resolve(this.workspaceRoot, rawPath);
    if (this.files.has(abs)) return this.files.get(abs)!;

    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      throw new Error(`not a regular file: ${abs}`);
    }
    const content = await fs.readFile(abs, "utf-8");
    const currentTotal = totalChars(this.files.values());
    if (currentTotal + content.length > MAX_CONTEXT_CHARS) {
      throw new Error(
        `attaching ${basename(abs)} would exceed the ${MAX_CONTEXT_CHARS / 1000}k context cap ` +
        `(${currentTotal} chars already attached + ${content.length} new). ` +
        `Use /clear or attach a smaller file.`,
      );
    }
    const file: AttachedFile = {
      path:     abs,
      relPath:  relative(this.workspaceRoot, abs) || basename(abs),
      content,
      bytes:    Buffer.byteLength(content, "utf-8"),
      language: detectLanguage(abs),
    };
    this.files.set(abs, file);
    return file;
  }

  remove(absPath: string): boolean {
    return this.files.delete(absPath);
  }

  /**
   * Build the BackendContext sent on the next /v1/chat/completions request.
   *
   * Strategy: the first attached file becomes `activeFile`. The rest are
   * concatenated as fenced markdown into the user prompt by the REPL (see
   * `buildPromptWithAttachments`). The backend's agent pipeline already
   * keys on activeFile for routing, so the first file should be the one
   * the user is asking about.
   */
  toBackendContext(): ChatContext | undefined {
    if (this.files.size === 0) return { workspacePath: this.workspaceRoot };
    const list  = this.list();
    const first = list[0]!;
    const rest  = list.slice(1);
    return {
      workspacePath: this.workspaceRoot,
      activeFile: {
        path:     first.path,
        content:  first.content,
        language: first.language,
      },
      recentFiles: rest.length > 0 ? rest.map((f) => f.path) : undefined,
    };
  }
}

/**
 * Build the user-facing prompt by concatenating the prompt with fenced blocks
 * for each attached file beyond the first (which the activeFile field
 * already covers). Keeps the user's prompt at the top — the model treats
 * the fenced blocks as data.
 */
export function buildPromptWithAttachments(
  promptText: string,
  attached:   AttachedFiles,
): string {
  const list = attached.list();
  if (list.length <= 1) return promptText;
  const rest = list.slice(1);
  const blocks: string[] = [promptText.trim()];
  blocks.push("");
  blocks.push("---");
  for (const f of rest) {
    blocks.push(`### ${f.relPath}`);
    blocks.push("```" + f.language);
    blocks.push(f.content);
    blocks.push("```");
  }
  blocks.push("---");
  return blocks.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectLanguage(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", rs: "rust", go: "go", rb: "ruby", java: "java",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    cs: "csharp", swift: "swift", kt: "kotlin",
    sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", html: "html", css: "css", scss: "scss",
    sql: "sql", graphql: "graphql", proto: "protobuf",
  };
  return map[ext] ?? "plaintext";
}
