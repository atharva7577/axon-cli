/**
 * permissions.ts — session-scoped allowlist + per-call prompt for
 * permission-gated tools (Bash, Write, Edit, WebFetch).
 *
 * Design follows Claude Code's per-call gate:
 *   - First time a tool is invoked with a given "key" (e.g. argv[0] for bash,
 *     parent dir for write, hostname for webfetch), prompt for permission.
 *   - User picks: allow once / always allow this key / deny.
 *   - "Always allow" writes the key into a Map<tool, Set<key>>, scoped to
 *     this REPL session — restart resets it.
 *
 * Read-only tools (read_file, glob, grep, ls) only call into this module when a
 * path escapes the workspace root — then they request "read_outside".
 */

import chalk from "chalk";
import prompts from "prompts";

export type PermissionTool = "bash" | "write_file" | "edit_file" | "web_fetch" | "read_outside" | "mcp";
export type PermissionDecision = "allow" | "always" | "deny";

export interface PermissionRequest {
  tool:     PermissionTool;
  /** Coarse key — argv[0], parent dir, hostname. Used for "always allow" matching. */
  key:      string;
  /** One-line human-readable summary (e.g. "$ npm run typecheck"). */
  summary:  string;
  /** Optional multi-line detail (e.g. the diff for edit_file). */
  detail?:  string;
}

export class PermissionStore {
  private always = new Map<PermissionTool, Set<string>>();

  /** True iff this tool+key is already in the always-allow list. */
  hasPermission(tool: PermissionTool, key: string): boolean {
    return this.always.get(tool)?.has(key) ?? false;
  }

  /** Persist an "always" grant for the rest of this session. */
  allowAlways(tool: PermissionTool, key: string): void {
    if (!this.always.has(tool)) this.always.set(tool, new Set());
    this.always.get(tool)!.add(key);
  }

  /**
   * Prompt the user (interactively). Resolves to the user's decision.
   * If stdin/stdout aren't TTYs (e.g. a piped script), defaults to "deny"
   * so a non-interactive run can't silently execute mutating code.
   */
  async request(req: PermissionRequest): Promise<PermissionDecision> {
    if (this.hasPermission(req.tool, req.key)) return "allow";

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(chalk.yellow(`\n  (denied — interactive permission needed for ${req.tool} "${req.key}")`));
      return "deny";
    }

    console.log("");
    console.log(chalk.bold.yellow(`  The model wants to use ${req.tool}:`));
    console.log("");
    console.log(`  ${chalk.cyan(req.summary)}`);
    if (req.detail) {
      console.log("");
      console.log(req.detail);
    }
    console.log("");

    const resp = await prompts({
      type:    "select",
      name:    "choice",
      message: "Allow?",
      choices: [
        { title: "Yes, once",                                value: "allow"  },
        { title: `Yes, and always allow '${req.key}' this session`, value: "always" },
        { title: "No, cancel this tool call",                value: "deny"   },
      ],
      initial: 0,
    }, {
      onCancel: () => { /* fall through to deny */ },
    });

    const decision = (resp.choice as PermissionDecision | undefined) ?? "deny";
    if (decision === "always") this.allowAlways(req.tool, req.key);
    return decision;
  }
}
