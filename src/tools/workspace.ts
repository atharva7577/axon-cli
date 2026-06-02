/**
 * workspace.ts — filesystem confinement for the agent's built-in file tools.
 *
 * Policy ("gate on escape"): the tools operate freely INSIDE the workspace root
 * (the git repo containing cwd, else cwd itself). Any path that *canonicalizes*
 * outside that root — via `..` traversal OR a symlink — is an escape:
 *   • read-only tools (read_file/ls/glob/grep) prompt for permission, and a
 *     non-TTY run denies (so a piped/scripted session can't be coerced);
 *   • mutating tools (write_file/edit_file) stay gated and additionally flag the
 *     target as OUTSIDE the workspace in the approval summary.
 *
 * This is the load-bearing defence against a poisoned AXON.md / jailbroken model
 * silently reading ~/.ssh, ~/.axon/config.json, .env, cloud creds, etc. and
 * echoing them back. The per-call permission gate remains the human boundary.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PermissionStore } from "../permissions.js";

/** Hard ceiling on the git-root walk (defensive; real repos are far shallower). */
const MAX_WALK_DEPTH = 50;

function findGitRoot(start: string): string | null {
  let dir = start;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

let cached: { cwd: string; root: string } | null = null;

/**
 * The workspace root: the git repo containing `cwd`, else `cwd` itself.
 * Canonicalized (realpath) so comparisons against canonical paths are sound.
 * Memoized by cwd — a long REPL session resolves this once.
 */
export function workspaceRoot(cwd: string = process.cwd()): string {
  if (cached && cached.cwd === cwd) return cached.root;
  const root = canonicalize(findGitRoot(cwd) ?? cwd);
  cached = { cwd, root };
  return root;
}

/** Drop the memoized root — tests change cwd between cases. */
export function _resetWorkspaceRootCache(): void {
  cached = null;
}

/**
 * Resolve `rawPath` to absolute, then canonicalize: realpath the longest
 * EXISTING prefix (resolving any symlinks) and re-append the non-existent tail.
 * So `../escape`, a `link -> /etc` symlink, and a not-yet-created file all map to
 * their true on-disk location.
 */
export function canonicalize(rawPath: string): string {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break; // reached the fs root
    tail.unshift(head.slice(parent.length + 1));
    head = parent;
  }
  let realHead: string;
  try { realHead = realpathSync(head); } catch { realHead = head; }
  return tail.length ? join(realHead, ...tail) : realHead;
}

/** True iff `absCanonical` is `root` or nested within it (segment-aware, not a raw prefix). */
export function isInsideRoot(absCanonical: string, root: string = workspaceRoot()): boolean {
  if (absCanonical === root) return true;
  const rel = relative(root, absCanonical);
  // Outside → rel starts with ".." (or is an absolute path on a different drive).
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export type GuardResult = { ok: true; abs: string } | { ok: false; error: string };

/**
 * Confine a READ to the workspace. Inside root → ok silently. Outside → prompt
 * (PermissionTool "read_outside", keyed on the canonical path so an approval is
 * scoped to that exact file); non-TTY / deny → error. Returns the canonical abs
 * so callers operate on the same path the gate authorised (no TOCTOU re-resolve).
 */
export async function guardRead(
  rawPath: string,
  perms:   PermissionStore,
  label:   string = "read",
): Promise<GuardResult> {
  const abs = canonicalize(rawPath);
  if (isInsideRoot(abs)) return { ok: true, abs };
  const decision = await perms.request({
    tool:    "read_outside",
    key:     abs,
    summary: `${label} OUTSIDE workspace: ${abs}`,
  });
  if (decision === "deny") {
    return { ok: false, error: `${label}: '${abs}' is outside the workspace and permission was denied` };
  }
  return { ok: true, abs };
}

/** Canonicalize a write/edit target and report whether it escapes the root. */
export function classifyWrite(rawPath: string): { abs: string; outside: boolean } {
  const abs = canonicalize(rawPath);
  return { abs, outside: !isInsideRoot(abs) };
}
