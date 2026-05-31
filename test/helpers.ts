/**
 * Shared test helpers for the M3 (AXON.md memory) battery.
 *
 * Everything is created under the OS temp dir and tracked for cleanup so we
 * never touch the user's real ~/.axon or working tree. `AXON_CONFIG_DIR` is the
 * sandbox hook (src/config.ts configDir()) — every test that calls resolveMemory
 * MUST point it at an isolated temp dir so the user's real global AXON.md can't
 * leak into a result.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const tracked: string[] = [];

/** Create a tracked temp directory (auto-cleaned by cleanupAll). */
export function tmpTree(prefix = "axon-m3-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tracked.push(d);
  return d;
}

/** Remove every tracked temp dir. Call from afterEach/afterAll. */
export function cleanupAll(): void {
  for (const d of tracked.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Write a file, creating parent dirs. */
export function writeFileDeep(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** Create a directory (recursive). */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Mark a directory as a git root by creating a .git dir inside it. */
export function makeGitRoot(dir: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

/** Probe once whether this platform lets us create file symlinks. */
export function canSymlink(): boolean {
  try {
    const d = mkdtempSync(join(tmpdir(), "axon-symprobe-"));
    const target = join(d, "t.txt");
    writeFileSync(target, "x");
    symlinkSync(target, join(d, "link"), "file");
    rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Create a file symlink (parent dirs ensured). Throws if unsupported. */
export function makeSymlink(target: string, linkPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, "file");
}

/** Set AXON_CONFIG_DIR and return a restore function. */
export function withConfigDir(dir: string): () => void {
  const prev = process.env.AXON_CONFIG_DIR;
  process.env.AXON_CONFIG_DIR = dir;
  return () => {
    if (prev === undefined) delete process.env.AXON_CONFIG_DIR;
    else process.env.AXON_CONFIG_DIR = prev;
  };
}

/** Normalize path separators so assertions are Windows/POSIX agnostic. */
export function norm(p: string): string {
  return p.replace(/\\/g, "/");
}
