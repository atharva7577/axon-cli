/**
 * rg — ripgrep-backed code search. Sub-second across large repos and respects
 * .gitignore, so the agent stops scanning O(files) per query. Falls back to the
 * pure-JS `grep` tool when ripgrep isn't on PATH, so installs never hard-depend
 * on rg. Read-only (no permission prompt), same args as `grep` — a transparent
 * speed upgrade wired into the existing `grep` tool dispatch.
 */

import { spawn } from "node:child_process";
import type { ToolResult } from "./registry.js";
import type { PermissionStore } from "../permissions.js";
import { workspaceRoot } from "./workspace.js";
import { grep, type GrepArgs } from "./grep.js";

const MAX_MATCHES   = 200;
const MAX_LINE_LEN  = 300;
const MAX_OUT_BYTES = 512_000;

/** Same shape as grep — a drop-in. */
export type RgArgs = GrepArgs;

/**
 * Run ripgrep, confined to `root` (so a `../` glob or in-repo symlink can't
 * escape — rg only reads files under cwd). Resolves `null` when rg isn't
 * installed (ENOENT) so the caller can fall back to the JS grep; resolves a
 * ToolResult otherwise. The pattern/glob are passed as discrete argv tokens
 * (no shell), so there is no command-injection surface.
 */
function runRipgrep(args: RgArgs, root: string): Promise<ToolResult | null> {
  return new Promise<ToolResult | null>((resolve) => {
    const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--no-messages"];
    if (args.case_insensitive) rgArgs.push("--ignore-case");
    if (args.path_glob) rgArgs.push("--glob", args.path_glob);
    rgArgs.push("--regexp", args.pattern, ".");

    let out = "";
    let err = "";
    let settled = false;
    const done = (r: ToolResult | null): void => { if (!settled) { settled = true; resolve(r); } };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("rg", rgArgs, { cwd: root });
    } catch {
      return done(null); // spawn threw synchronously — treat rg as unavailable
    }

    child.on("error", (e: NodeJS.ErrnoException) => {
      // ENOENT = ripgrep not installed → signal fallback; surface other errors.
      done(e?.code === "ENOENT" ? null : { ok: false, error: `grep: ${e.message}` });
    });
    child.stdout?.on("data", (d) => { if (out.length < MAX_OUT_BYTES) out += d.toString("utf-8"); });
    child.stderr?.on("data", (d) => { err += d.toString("utf-8"); });
    child.on("close", (code) => {
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (code === 2) { done({ ok: false, error: `grep: ${err.trim() || "ripgrep search error"}` }); return; }
      const all = out.split("\n").filter(Boolean);
      const truncated = all.length > MAX_MATCHES;
      const shown = all.slice(0, MAX_MATCHES).map((l) =>
        l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + "…" : l,
      );
      done({
        ok: true,
        result: shown.length > 0
          ? `${shown.length}${truncated ? "+" : ""} match${shown.length === 1 ? "" : "es"} (ripgrep):\n${shown.join("\n")}`
          : "(no matches)",
        truncated,
      });
    });
  });
}

/**
 * The `grep` tool's executor: ripgrep when available, pure-JS grep otherwise.
 * Identical result contract either way, so callers and the model are unaware
 * of which engine ran.
 */
export async function rg(args: RgArgs, perms: PermissionStore): Promise<ToolResult> {
  if (!args.pattern || typeof args.pattern !== "string") {
    return { ok: false, error: "grep: 'pattern' is required" };
  }
  const viaRg = await runRipgrep(args, workspaceRoot(process.cwd()));
  if (viaRg !== null) return viaRg;
  // ripgrep not installed — transparent fallback to the pure-JS grep.
  return grep(args, perms);
}
