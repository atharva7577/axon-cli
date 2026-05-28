/**
 * schemas.ts — OpenAI-spec function definitions for every built-in tool.
 *
 * The backend's tool-mode handler (`backend/src/routes/completions.ts`)
 * routes to a tool-capable model and forwards this array verbatim, so the
 * shape MUST match OpenAI's function-calling schema.
 *
 * Schema descriptions are read directly by the model — make them
 * unambiguous about what each tool does and when the model should use it.
 */

export interface ToolSchema {
  type: "function";
  function: {
    name:         string;
    description:  string;
    parameters: {
      type:       "object";
      properties: Record<string, { type: string; description: string; items?: unknown; enum?: string[] }>;
      required?:  string[];
    };
  };
}

export const READ_FILE: ToolSchema = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read the contents of a file from the user's local filesystem. Returns the " +
      "content with 1-based line numbers prefixed. Capped at 32k chars; large files " +
      "return a truncation marker. Use this whenever you need to know what's in a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or cwd-relative path to the file." },
        offset: { type: "number", description: "Optional: start at this 1-based line number." },
        limit:  { type: "number", description: "Optional: read at most this many lines." },
      },
      required: ["path"],
    },
  },
};

export const GLOB: ToolSchema = {
  type: "function",
  function: {
    name: "glob",
    description:
      "Find files whose path matches a glob pattern (e.g. 'src/**/*.ts', " +
      "'**/*.{md,json}'). Returns up to 200 paths, newest-modified first. Use " +
      "this to discover what files exist before reading them.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern relative to cwd." },
        cwd:     { type: "string", description: "Optional: search root (default: process.cwd())." },
      },
      required: ["pattern"],
    },
  },
};

export const GREP: ToolSchema = {
  type: "function",
  function: {
    name: "grep",
    description:
      "Search file contents for a regex pattern across a glob. Returns up to 100 " +
      "matches (path:line:content). Use this for 'find every reference to X' or " +
      "'where is Y defined?' questions.",
    parameters: {
      type: "object",
      properties: {
        pattern:    { type: "string", description: "JavaScript regex (without slashes)." },
        path_glob:  { type: "string", description: "Optional glob filter (default: '**/*')." },
        case_insensitive: { type: "boolean", description: "Default: false." },
      },
      required: ["pattern"],
    },
  },
};

export const LS: ToolSchema = {
  type: "function",
  function: {
    name: "ls",
    description:
      "List entries in a directory. Each entry is marked [d] for directory or [f] " +
      "for file, with byte size. Use this to discover folder structure.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional directory path (default: cwd)." },
      },
    },
  },
};

export const BASH: ToolSchema = {
  type: "function",
  function: {
    name: "bash",
    description:
      "Run a shell command on the user's machine. REQUIRES PERMISSION — the " +
      "user is asked each time unless they've granted always-allow for this " +
      "command's first token. Returns exit code, stdout, stderr. Use sparingly " +
      "and prefer the read-only tools (read_file/glob/grep/ls) when you only " +
      "need to look around.",
    parameters: {
      type: "object",
      properties: {
        command:   { type: "string", description: "The full command line." },
        timeoutMs: { type: "number", description: "Optional: kill the command after this many ms (default 30000)." },
      },
      required: ["command"],
    },
  },
};

export const WRITE_FILE: ToolSchema = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "Create a new file or overwrite an existing one with the supplied content. " +
      "REQUIRES PERMISSION. Parent directories are created automatically. Prefer " +
      "edit_file for changes to existing files — write_file is for whole-file " +
      "rewrites and brand-new files.",
    parameters: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Absolute or cwd-relative path." },
        content: { type: "string", description: "The complete file content." },
      },
      required: ["path", "content"],
    },
  },
};

export const EDIT_FILE: ToolSchema = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "Replace a specific block of text in an existing file. REQUIRES PERMISSION. " +
      "Supply the exact existing text (`old`) and its complete replacement (`new`). " +
      "The change is shown to the user as a colourised diff before they decide. " +
      "Use this for targeted edits — read the file first if you're not sure of the " +
      "exact text to match.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or cwd-relative path of the file to edit." },
        old:  { type: "string", description: "Exact existing text to find. Must match verbatim (whitespace too)." },
        new:  { type: "string", description: "Replacement text — complete, no '...' placeholders." },
      },
      required: ["path", "old", "new"],
    },
  },
};

export const WEB_FETCH: ToolSchema = {
  type: "function",
  function: {
    name: "web_fetch",
    description:
      "Fetch the contents of a URL (HTTP GET). REQUIRES PERMISSION. Returns the " +
      "body as text, truncated to 32k chars. Use sparingly — prefer read_file when " +
      "the answer is on disk.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch. Must start with http:// or https://." },
      },
      required: ["url"],
    },
  },
};

/** Full kit shipped in v0.0.7 — REPL agentic baseline. */
export const ALL_TOOLS: ToolSchema[] = [
  READ_FILE,
  GLOB,
  GREP,
  LS,
  BASH,
  WRITE_FILE,
  EDIT_FILE,
  WEB_FETCH,
];
