/**
 * editorEvents.ts — Layer 3 learning loop (client side).
 *
 * After the CLI applies (or fails to apply) an edit a model proposed, it POSTs
 * an outcome to the backend's /v1/editor/events. The backend's
 * editorOutcomeReconciler joins this to the routing-experience stub by
 * requestId and records it in the stratified outcome store — so routing learns
 * which model actually lands edits per tenant/domain over time.
 *
 * Best-effort and non-blocking: never throws, never delays the agent turn.
 * Respects `telemetry: false` in the user's config.
 */
import { readConfig } from "./config.js";

export type EditorEventName = "edit_applied" | "edit_accepted" | "edit_rejected";

export interface EditorEventOpts {
  apiBase: string;
  apiKey?: string;
  signal?: AbortSignal;
}

/**
 * Fire an editor outcome event. `requestId` is the id of the completion that
 * proposed the edit (from the response meta). The backend forces the real
 * tenantId from the bearer token, so the placeholder sent here is discarded.
 */
export async function postEditorEvent(
  event:     EditorEventName,
  requestId: string | undefined,
  opts:      EditorEventOpts,
): Promise<void> {
  if (!requestId || !opts.apiKey) return;
  try {
    const cfg = readConfig();
    if (cfg.telemetry === false) return;
    const apiBase = (opts.apiBase || cfg.apiBase).replace(/\/+$/, "");
    await fetch(`${apiBase}/v1/editor/events`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${opts.apiKey}` },
      body:    JSON.stringify({ event, requestId, tenantId: "client", timestamp: Date.now() }),
      signal:  opts.signal,
    });
  } catch {
    // Telemetry is best-effort — swallow all errors.
  }
}
