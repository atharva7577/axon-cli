/**
 * sse.ts — minimal Server-Sent Events parser for the AXON /v1/chat/completions
 * streaming response.
 *
 * The backend emits OpenAI-spec chunks (one `data: {json}\n\n` per chunk),
 * terminated by `data: [DONE]\n\n`. Custom AXON fields (`meta`, `code_edit`,
 * `extra_files`, `budget`) ride on the final chunk as top-level keys.
 *
 * We yield three event kinds:
 *   • `delta`   — incremental text chunks (assistant content)
 *   • `done`    — final chunk just before [DONE] — exposes usage + meta + extras
 *   • `chunk`   — raw chunk pass-through for callers that want full control
 *
 * No abort handling beyond what the caller's AbortSignal does to the fetch.
 */

import { readConfig } from "./config.js";
import { AxonBackendError } from "./http.js";

export interface SseFinalChunk {
  id?:           string;
  object?:       string;
  created?:      number;
  model?:        string;
  choices?:      Array<{ index?: number; delta?: { content?: string }; finish_reason?: string | null }>;
  usage?:        { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  meta?:         Record<string, unknown>;
  code_edit?:    unknown;
  extra_files?:  unknown[];
  budget?:       Record<string, unknown>;
  // Allow any extra AXON fields without TS complaining.
  [key: string]: unknown;
}

/**
 * One slice of a streamed tool_call. OpenAI emits these index-keyed across
 * many chunks: the `id` + `name` arrive in the first slice for that index;
 * `argumentsDelta` accumulates over subsequent slices until finish_reason.
 */
export interface SseToolCallDelta {
  index:           number;
  id?:             string;
  name?:           string;
  argumentsDelta?: string;
}

export type SseEvent =
  | { type: "delta";           text:  string }
  | { type: "tool_call_delta"; delta: SseToolCallDelta }
  | { type: "done";             final: SseFinalChunk }
  | { type: "chunk";            raw:   Record<string, unknown> };

export interface SseRequestOptions {
  apiBase:   string;
  apiKey?:   string;
  byok?:     { openai?: string; anthropic?: string; google?: string };
  signal?:   AbortSignal;
  timeoutMs?: number;
}

/**
 * POST to /v1/chat/completions with `stream: true` and yield SSE events as
 * they arrive. The caller decides which event types to surface.
 */
export async function* streamChat(
  body:    Record<string, unknown>,
  options: SseRequestOptions,
): AsyncGenerator<SseEvent, void, unknown> {
  const cfg = readConfig();
  const apiBase = (options.apiBase || cfg.apiBase).replace(/\/+$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept":       "text/event-stream",
    "User-Agent":   `axon-cli/${process.env.npm_package_version ?? "dev"} node/${process.versions.node}`,
  };
  if (options.apiKey) headers["Authorization"]   = `Bearer ${options.apiKey}`;
  if (options.byok?.openai)    headers["x-openai-key"]    = options.byok.openai;
  if (options.byok?.anthropic) headers["x-anthropic-key"] = options.byok.anthropic;
  if (options.byok?.google)    headers["x-google-key"]    = options.byok.google;

  // Force stream:true even if caller forgot — this whole module is the
  // streaming consumer; calling non-stream would deadlock the SSE parser.
  const payload = { ...body, stream: true };

  // Compose timeout with optional caller signal.
  const ctl = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ctl.abort((options.signal as AbortSignal | undefined)?.reason);
  options.signal?.addEventListener("abort", onAbort);

  let res: Response;
  try {
    res = await fetch(`${apiBase}/v1/chat/completions`, {
      method:  "POST",
      headers,
      body:    JSON.stringify(payload),
      signal:  ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    let parsed: unknown = null;
    try { parsed = await res.json(); } catch { /* non-JSON */ }
    const err = (parsed as { error?: { message?: string; code?: string; type?: string; provider?: string } } | null)?.error ?? {};
    throw new AxonBackendError({
      status:   res.status,
      code:     err.code    ?? `http_${res.status}`,
      type:     err.type    ?? "server_error",
      message:  err.message ?? `HTTP ${res.status}`,
      provider: err.provider,
      raw:      parsed,
    });
  }

  if (!res.body) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    throw new Error("Backend returned no response body.");
  }

  const decoder = new TextDecoder("utf-8");
  const reader  = res.body.getReader();
  let buffer = "";
  let lastChunk: SseFinalChunk | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on SSE event boundary. Each event is `data: <payload>\n\n`.
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const eventBlock = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        // Each block may have multiple `data:` lines (we never produce comments
        // or event: prefixes server-side, so this stays simple).
        const dataLines = eventBlock
          .split("\n")
          .map((l) => l.trimStart())
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;

        const payloadText = dataLines.join("\n");
        if (payloadText === "[DONE]") {
          if (lastChunk) yield { type: "done", final: lastChunk };
          return;
        }
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(payloadText); } catch { continue; }

        lastChunk = parsed as SseFinalChunk;
        yield { type: "chunk", raw: parsed };

        const choice = (parsed.choices as Array<{
          delta?: {
            content?:    string;
            tool_calls?: Array<{
              index:    number;
              id?:      string;
              type?:    string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }> | undefined)?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          yield { type: "delta", text: delta };
        }
        const toolDeltas = choice?.delta?.tool_calls;
        if (Array.isArray(toolDeltas)) {
          for (const td of toolDeltas) {
            yield {
              type: "tool_call_delta",
              delta: {
                index:          td.index,
                id:             td.id,
                name:           td.function?.name,
                argumentsDelta: td.function?.arguments,
              },
            };
          }
        }
      }
    }
    // Stream ended without an explicit [DONE] — still surface the final
    // chunk we saw so the caller gets meta/usage.
    if (lastChunk) yield { type: "done", final: lastChunk };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
