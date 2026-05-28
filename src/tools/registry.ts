/**
 * registry.ts — dispatch a parsed tool_call to its executor.
 *
 * Called from src/agent.ts in a sequential loop. Each executor returns a
 * ToolResult; the agent loop serialises it to JSON and appends a `role:"tool"`
 * message before re-streaming.
 */

import chalk from "chalk";
import type { PermissionStore } from "../permissions.js";
import { readFile,  type ReadFileArgs  } from "./read.js";
import { glob,      type GlobArgs      } from "./glob.js";
import { grep,      type GrepArgs      } from "./grep.js";
import { ls,        type LsArgs        } from "./ls.js";
import { bash,      type BashArgs      } from "./bash.js";
import { writeFile, type WriteFileArgs } from "./write.js";
import { editFile,  type EditFileArgs  } from "./edit.js";
import { webFetch,  type WebFetchArgs  } from "./webfetch.js";

export interface ToolResult {
  ok:         boolean;
  result?:    string;
  error?:     string;
  truncated?: boolean;
}

export interface ToolCall {
  id:        string;
  name:      string;
  arguments: string;
}

/** Format a tool call as a one-line preview for the REPL. */
export function summarizeToolCall(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments); } catch { /* leave empty */ }
  const head = (k: string) => {
    const v = args[k];
    return typeof v === "string"
      ? (v.length > 80 ? v.slice(0, 77) + "…" : v)
      : JSON.stringify(v);
  };
  switch (call.name) {
    case "read_file":  return `read_file(${head("path")})`;
    case "glob":       return `glob(${head("pattern")})`;
    case "grep":       return `grep(${head("pattern")}${args.path_glob ? `, ${head("path_glob")}` : ""})`;
    case "ls":         return `ls(${head("path") || "."})`;
    case "bash":       return `bash(${head("command")})`;
    case "write_file": return `write_file(${head("path")})`;
    case "edit_file":  return `edit_file(${head("path")})`;
    case "web_fetch":  return `web_fetch(${head("url")})`;
    default:           return `${call.name}(…)`;
  }
}

/** Run a tool call and return a serialised result. */
export async function dispatchTool(call: ToolCall, perms: PermissionStore): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch (err) {
    return { ok: false, error: `bad tool arguments: ${(err as Error).message}\nargs: ${call.arguments}` };
  }

  // Print the tool header so the user sees the model's plan.
  console.log("");
  console.log(chalk.dim(`  ⏵ ${summarizeToolCall({ ...call, arguments: JSON.stringify(args) })}`));

  switch (call.name) {
    case "read_file":  return readFile(args as unknown as ReadFileArgs);
    case "glob":       return glob(args as unknown as GlobArgs);
    case "grep":       return grep(args as unknown as GrepArgs);
    case "ls":         return ls(args as unknown as LsArgs);
    case "bash":       return bash(args as unknown as BashArgs, perms);
    case "write_file": return writeFile(args as unknown as WriteFileArgs, perms);
    case "edit_file":  return editFile(args as unknown as EditFileArgs, perms);
    case "web_fetch":  return webFetch(args as unknown as WebFetchArgs, perms);
    default:
      return { ok: false, error: `unknown tool: ${call.name}` };
  }
}
