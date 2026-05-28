/**
 * bash — run a shell command, capture exit code + stdout + stderr.
 *
 * Cross-platform: on Windows we use cmd.exe /c, elsewhere /bin/sh -c.
 * Permission-gated: caller must consult PermissionStore.request first.
 * Default 30s timeout, configurable per call.
 */

import { spawn } from "node:child_process";
import type { ToolResult } from "./registry.js";
import type { PermissionStore } from "../permissions.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16_000;

export interface BashArgs {
  command:    string;
  timeoutMs?: number;
}

/** Coarse permission key: first token of the command (executable name). */
function permissionKey(cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed) return "(empty)";
  const m = trimmed.match(/^("([^"]+)"|'([^']+)'|(\S+))/);
  return (m?.[2] ?? m?.[3] ?? m?.[4] ?? trimmed.split(/\s+/)[0] ?? "(unknown)").toLowerCase();
}

export async function bash(args: BashArgs, perms: PermissionStore): Promise<ToolResult> {
  if (!args.command || typeof args.command !== "string") {
    return { ok: false, error: "bash: 'command' is required" };
  }
  const key = permissionKey(args.command);
  const decision = await perms.request({
    tool:    "bash",
    key,
    summary: `$ ${args.command.length > 200 ? args.command.slice(0, 200) + "…" : args.command}`,
  });
  if (decision === "deny") {
    return { ok: false, error: "bash: user denied permission" };
  }

  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const flag  = isWin ? "/c"      : "-c";

  return new Promise<ToolResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    const child = spawn(shell, [flag, args.command], { cwd: process.cwd(), env: process.env });
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d.toString("utf-8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `bash spawn failed: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let truncated = false;
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n… [stdout truncated]";
        truncated = true;
      }
      if (stderr.length > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n… [stderr truncated]";
        truncated = true;
      }
      const body = [
        `exit code: ${killed ? "killed (timeout)" : code}`,
        stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
        stderr ? `stderr:\n${stderr}` : "stderr: (empty)",
      ].join("\n");
      resolve({
        ok:       !killed && code === 0,
        result:   body,
        error:    killed ? "bash: timed out" : (code !== 0 ? `bash: exit ${code}` : undefined),
        truncated,
      });
    });
  });
}
