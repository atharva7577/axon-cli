/**
 * globFiles — Node 20–compatible file globbing.
 *
 * Replaces Node 22's `fs/promises#glob`, whose *static* import crashed `axon`
 * at module-link time on Node 20 ("does not provide an export named 'glob'").
 * commander@14 already floors us at Node >= 20, so 20 is the supported baseline.
 *
 * Deliberate properties (security + cross-platform correctness):
 *   • Never follows symlinks — we only descend into real directories
 *     (`dirent.isDirectory()`), preserving the workspace-confinement guarantee
 *     the read tools rely on. Symlinked dirs/files are skipped.
 *   • Emits POSIX-separator relative paths so minimatch + display are stable on
 *     Windows (the platform the install bug surfaced on).
 *   • Prunes excluded directories during descent (faster than walk-then-filter;
 *     never reads into node_modules/.git/etc.).
 *   • Only matches files at or below `cwd` — a `../…` pattern matches nothing,
 *     which is strictly safer than the old behavior (it could walk upward, then
 *     filter). The agent file tools always operate inside the workspace anyway.
 */

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { minimatch } from "minimatch";

export interface GlobFilesOpts {
  /** Absolute base directory to walk. */
  cwd: string;
  /** Directory base-names to skip entirely (not descended into). */
  excludeDirs?: readonly string[];
  /** Hard cap on emitted paths (safety net; default 5000). */
  max?: number;
}

/**
 * Return relative (POSIX-separator) paths of files under `cwd` matching the
 * glob `pattern`. Globstar (`**`) is on by default in minimatch; dotfiles are
 * excluded (`dot: false`), matching typical glob semantics.
 */
export async function globFiles(pattern: string, opts: GlobFilesOpts): Promise<string[]> {
  const { cwd, excludeDirs = [], max = 5000 } = opts;
  const exclude = new Set(excludeDirs);
  const out: string[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, races) — skip
    }
    for (const ent of entries) {
      if (out.length >= max) return;
      const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (exclude.has(ent.name)) continue;            // prune excluded trees
        await walk(join(absDir, ent.name), relPath);    // real dirs only → never follows symlinks
      } else if (ent.isFile()) {
        if (minimatch(relPath, pattern, { dot: false })) out.push(relPath);
      }
      // symlinks / sockets / fifos: isDirectory()===isFile()===false → ignored.
    }
  }

  await walk(cwd, "");
  return out;
}
