/**
 * telemetry.ts — closed-loop editor_events poster.
 *
 * This is the moat in motion: every time a user accepts or rejects a code_edit
 * in the terminal, AXON learns which model handled that prompt successfully
 * for *that tenant*. Future routing for similar prompts shifts toward the
 * model that earned the accept.
 *
 * Default-on, with consent surfaced at first run (see onboarding.ts) and a
 * permanent off-switch via `axon config set telemetry off` or --no-telemetry.
 */

import { postJson, AxonBackendError } from "./http.js";
import { readConfig } from "./config.js";

export type EditorEventName =
  | "edit_proposed"
  | "edit_applied"
  | "edit_accepted"
  | "edit_rejected";

export interface EditorEventInput {
  event:     EditorEventName;
  requestId: string;
  filePath?: string;
  /** edit_rejected: how did the user reject? (button | keybinding | undo | timeout) */
  method?:   string;
  /** edit_accepted: ms the file stayed un-edited after apply, if measured. */
  stabilityWindowMs?: number;
}

interface EditorEventWire extends EditorEventInput {
  tenantId:  string;
  timestamp: number;
}

/**
 * Fire-and-forget POST to /v1/editor/events. Returns void on success; logs
 * (and swallows) network errors so a flaky connection never blocks the REPL.
 * Returns false when telemetry is disabled or no api key is on file.
 */
export async function postEditorEvent(input: EditorEventInput): Promise<boolean> {
  const cfg = readConfig();
  if (cfg.telemetry === false) return false;
  if (!cfg.apiKey) return false;

  const wire: EditorEventWire = {
    ...input,
    // Backend overwrites tenantId from the bearer-auth context, but the
    // validation gate insists on a string field — send the configured one.
    tenantId:  cfg.tenantId ?? "cli",
    timestamp: Date.now(),
  };

  try {
    await postJson("/v1/editor/events", wire, { timeoutMs: 10_000 });
    return true;
  } catch (err) {
    if (err instanceof AxonBackendError) {
      // 401 is meaningful — surface to the caller via a logged warning so
      // the REPL can suggest re-login. 5xx is transient — swallow quietly.
      if (err.status === 401) {
        console.warn(`[telemetry] ${err.code}: ${err.message} — run \`axon login\` to refresh.`);
      }
    }
    return false;
  }
}
