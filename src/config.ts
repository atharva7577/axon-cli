/**
 * config.ts — the on-disk shape of `~/.axon/config.json`.
 *
 * The file is chmod 600 — readable only by the user. The CLI refuses to
 * read or write if the parent dir is world-writable to avoid a tempdir-
 * style hijack of `axon` invocations.
 */

import { existsSync, chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AxonConfig {
  /** Backend base URL. Defaults to the hosted gateway. */
  apiBase:      string;
  /** Tenant API key. `axon login` writes this. */
  apiKey?:      string;
  /** Default model hint for `axon chat` (M1). "auto" lets AXON route. */
  defaultModel: string;
  /** Closed-loop accept/reject telemetry. Default-on; first-run prints a notice. */
  telemetry:    boolean;
  /** Admin secret for `axon admin …` (M5). Distinct from apiKey. */
  adminSecret?: string;
  /** Tenant id resolved at login time. Display-only. */
  tenantId?:    string;
  /** ISO timestamp when the config was last written. */
  updatedAt?:   string;
}

const DEFAULTS: AxonConfig = {
  apiBase:      "https://api.axon.nexalyte.tech",
  defaultModel: "auto",
  telemetry:    true,
};

export function configDir(): string {
  return process.env.AXON_CONFIG_DIR?.trim() || join(homedir(), ".axon");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/**
 * Refuse a config dir that is group/other-writable (a tempdir-style hijack of
 * `axon` invocations). POSIX-only — Windows mode bits are synthetic, ACLs govern.
 */
function assertDirNotWorldWritable(dir: string): void {
  if (process.platform === "win32") return;
  let st;
  try { st = statSync(dir); } catch { return; }
  if ((st.mode & 0o022) !== 0) {
    throw new Error(`config: ${dir} is group/other-writable — refusing to use it. Run: chmod 700 ${dir}`);
  }
}

/** Read the config, layered over the defaults. Missing file → defaults only. */
export function readConfig(): AxonConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  assertDirNotWorldWritable(configDir());
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AxonConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    throw new Error(`config: ${path} is unreadable (${(err as Error).message}). Delete it or fix the JSON.`);
  }
}

/** Write the config atomically (tmp → fsync-less rename) and chmod 600. */
export function writeConfig(next: AxonConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertDirNotWorldWritable(dir);
  const path = configPath();
  const tmp  = `${path}.tmp`;
  const payload: AxonConfig = { ...next, updatedAt: new Date().toISOString() };
  const json = JSON.stringify(payload, null, 2) + "\n";
  // Write the tmp with restrictive perms, then atomically replace the target.
  // A single rename() means a crash leaves EITHER the old file OR the new one —
  // never a truncated/absent config (the old unlink-then-rewrite could lose it).
  writeFileSync(tmp, json, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* no-op on win32 */ }
  renameSync(tmp, path); // POSIX rename() / win32 MoveFileEx — atomic, overwrites.
  try { chmodSync(path, 0o600); } catch { /* no-op on win32 */ }
}

/** Persist a partial patch. Pass `apiKey: undefined` to clear it on logout. */
export function patchConfig(patch: Partial<AxonConfig>): AxonConfig {
  const current = readConfig();
  const next: AxonConfig = { ...current, ...patch };
  // null-coalesce defaults so we never persist an empty string for required keys.
  if (!next.apiBase)      next.apiBase      = DEFAULTS.apiBase;
  if (!next.defaultModel) next.defaultModel = DEFAULTS.defaultModel;
  writeConfig(next);
  return next;
}

/** Wipe the api key + tenant binding (`axon logout`). */
export function clearAuth(): AxonConfig {
  const current = readConfig();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKey: _k, tenantId: _t, adminSecret: _s, ...rest } = current;
  const next: AxonConfig = { ...DEFAULTS, ...rest };
  writeConfig(next);
  return next;
}

export const DEFAULT_CONFIG = DEFAULTS;
