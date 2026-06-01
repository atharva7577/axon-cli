/**
 * permKey — derive the "always allow" permission key for a tool call.
 *
 * Keys are intentionally EXACT (Balanced policy): a grant matches only the same
 * command / the same file, so "always allow" can't be widened by a later call
 * with different arguments. (web_fetch keys on hostname in webfetch.ts — a host
 * is the natural unit there.)
 */

import { relative, isAbsolute, resolve } from "node:path";

/** Full command, whitespace-normalized. `"npm test"` ≠ `"npm run build"`. */
export function commandPermissionKey(cmd: string): string {
  const norm = cmd.trim().replace(/\s+/g, " ");
  return norm || "(empty)";
}

/** Exact file path, relative to cwd, `/`-normalized. `src/a.ts` ≠ `src/b.ts`. */
export function filePermissionKey(pathArg: string): string {
  const abs = isAbsolute(pathArg) ? pathArg : resolve(process.cwd(), pathArg);
  const rel = relative(process.cwd(), abs);
  return (rel || abs).replace(/\\/g, "/");
}
