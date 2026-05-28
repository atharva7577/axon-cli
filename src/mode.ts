/**
 * mode.ts — session-mode state for the REPL.
 *
 * VS Code's CodingModeController persists per-workspace via workspaceState.
 * The CLI keeps this in memory for the lifetime of the REPL — re-launching
 * `axon` starts in the default mode. `/mode <auto|coding|chat>` flips it.
 */

export type SessionMode = "auto" | "coding" | "chat";

export const DEFAULT_SESSION_MODE: SessionMode = "auto";

export function isSessionMode(s: string): s is SessionMode {
  return s === "auto" || s === "coding" || s === "chat";
}
