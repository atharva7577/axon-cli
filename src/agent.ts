/**
 * agent.ts — multi-turn tool-use loop.
 *
 * Sends the current message history + the full tool schema to the backend's
 * tool-mode handler. As the stream comes back:
 *   - content deltas print to stdout incrementally
 *   - tool_call deltas accumulate into a Map keyed by index
 * When the stream ends with `finish_reason: "tool_calls"`, each accumulated
 * call is executed sequentially. Each result is appended as a `role: "tool"`
 * message and the loop runs again. When the model returns a pure-text answer
 * (no tool_calls), we print the routing trace and return.
 *
 * The caller (REPL or `axon chat --agent`) owns the messages array.
 */

import chalk from "chalk";
import { AxonBackendError } from "./http.js";
import { streamChat, type SseFinalChunk } from "./sse.js";
import { ALL_TOOLS, type ToolSchema } from "./tools/schemas.js";
import { dispatchTool, dispatchMcpCall, type ToolCall, type ToolResult } from "./tools/registry.js";
import { PermissionStore } from "./permissions.js";
import type { McpClientPool } from "./mcp/client.js";

/** Per-call ceiling on accumulated tool-call arguments (OOM / runaway-stream guard). */
const MAX_TOOL_ARGS_BYTES = 256_000;

export interface ChatMessage {
  role:           "system" | "user" | "assistant" | "tool";
  content:        string | null;
  /** Present on assistant messages that requested tool calls. */
  tool_calls?:    Array<{
    id:       string;
    type:     "function";
    function: { name: string; arguments: string };
  }>;
  /** Required on role:"tool" messages — the id of the call this answers. */
  tool_call_id?: string;
}

export interface AgentOptions {
  apiBase:    string;
  apiKey:     string;
  model:      string;
  mode:       "auto" | "coding" | "chat";
  byok?:      { openai?: string; anthropic?: string; google?: string };
  signal?:    AbortSignal;
  /** Hard ceiling on round-trips. Default 25. */
  maxTurns?:  number;
  /** Print the final routing trace line. Default true. */
  showMeta?:  boolean;
  /** Live MCP server pool — calls to its tools route here instead of the built-ins. */
  mcpPool?:   McpClientPool;
  /** Extra tool schemas (e.g. the MCP pool's) merged with the 8 built-ins. */
  extraTools?: ToolSchema[];
}

function formatMetaLine(final: SseFinalChunk): string | null {
  const meta = (final.meta ?? {}) as Record<string, unknown>;
  const model = (typeof final.model === "string" && final.model) || (meta.model as string | undefined);
  if (!model) return null;
  const reasons: string[] = [];
  if (meta.fastPath) reasons.push(`fast-path ${meta.fastPath}`);
  if (meta.routing)  reasons.push(meta.routing as string);
  else if (meta.intent) reasons.push(`intent ${meta.intent}`);
  const tail: string[] = [];
  if (typeof meta.cost         === "number") tail.push(`$${(meta.cost as number).toFixed(4)} spent`);
  if (typeof meta.creditsSaved === "number") tail.push(`$${(meta.creditsSaved as number).toFixed(4)} saved`);
  const head = reasons.length > 0 ? `routed ${model} via ${reasons.join(", ")}` : `routed ${model}`;
  return tail.length > 0 ? `${head} (${tail.join(", ")})` : head;
}

/**
 * Consume a single agent stream — print content, accumulate tool calls.
 * Resolves with the assistant message that should be appended to history.
 */
async function consumeStream(
  messages: ChatMessage[],
  opts:     AgentOptions,
): Promise<{ assistant: ChatMessage; toolCalls: ToolCall[]; final: SseFinalChunk | null }> {
  const body = {
    model:    opts.model,
    messages,
    stream:   true,
    mode:     opts.mode,
    tools:    [...ALL_TOOLS, ...(opts.extraTools ?? [])],
    parallel_tool_calls: false,
  };
  const stream = streamChat(body, {
    apiBase: opts.apiBase,
    apiKey:  opts.apiKey,
    byok:    opts.byok,
    signal:  opts.signal,
    timeoutMs: 180_000,
  });

  let content = "";
  let final: SseFinalChunk | null = null;
  const toolBuffers = new Map<number, { id?: string; name?: string; args: string; overflow?: boolean }>();

  for await (const ev of stream) {
    if (ev.type === "delta") {
      process.stdout.write(ev.text);
      content += ev.text;
    } else if (ev.type === "tool_call_delta") {
      const idx = ev.delta.index;
      const cur = toolBuffers.get(idx) ?? { args: "" };
      if (ev.delta.id)   cur.id   = ev.delta.id;
      if (ev.delta.name) cur.name = ev.delta.name;
      // Cap accumulation so a buggy/malicious backend can't grow args unbounded.
      if (ev.delta.argumentsDelta && !cur.overflow) {
        if (cur.args.length + ev.delta.argumentsDelta.length > MAX_TOOL_ARGS_BYTES) {
          cur.overflow = true; // stop growing; surfaced as a clean parse error below
        } else {
          cur.args += ev.delta.argumentsDelta;
        }
      }
      toolBuffers.set(idx, cur);
    } else if (ev.type === "done") {
      final = ev.final;
    }
  }

  const indices = [...toolBuffers.keys()].sort((a, b) => a - b);
  const toolCalls: ToolCall[] = indices.map((i) => {
    const buf = toolBuffers.get(i)!;
    return {
      id:        buf.id ?? `call_${i}`,
      name:      buf.name ?? "",
      arguments: buf.overflow ? "[oversized: tool arguments exceeded the 256 KB limit]" : (buf.args ?? ""),
    };
  }).filter((c) => c.name); // drop empty/stale slots

  const assistant: ChatMessage = {
    role:    "assistant",
    content: content || null,
    ...(toolCalls.length > 0 ? {
      tool_calls: toolCalls.map((c) => ({
        id:       c.id,
        type:     "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    } : {}),
  };

  return { assistant, toolCalls, final };
}

export async function runAgentTurn(
  messages: ChatMessage[],
  perms:    PermissionStore,
  opts:     AgentOptions,
): Promise<void> {
  const maxTurns = opts.maxTurns ?? 25;
  let lastFinal: SseFinalChunk | null = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    let assistant: ChatMessage;
    let toolCalls: ToolCall[];
    let final: SseFinalChunk | null;
    try {
      ({ assistant, toolCalls, final } = await consumeStream(messages, opts));
    } catch (err) {
      if (err instanceof AxonBackendError) {
        if (err.status === 401) {
          console.error("\n" + chalk.red("✗ Invalid or revoked key.") + " Run " + chalk.bold("axon login") + " to refresh.");
        } else {
          console.error("\n" + chalk.red(`✗ ${err.message}`) + chalk.dim(`  (${err.code})`));
        }
      } else {
        console.error("\n" + chalk.red(`✗ ${(err as Error).message ?? err}`));
      }
      return;
    }

    messages.push(assistant);
    if (final) lastFinal = final;

    if (toolCalls.length === 0) {
      // Pure-text answer. Flush trailing newline + routing trace.
      process.stdout.write("\n");
      if (opts.showMeta !== false && lastFinal) {
        const line = formatMetaLine(lastFinal);
        if (line) console.log(chalk.dim(`> ${line}`));
      }
      return;
    }

    // Newline so the tool-call list isn't glued to streamed assistant text.
    process.stdout.write("\n");

    // Execute each tool call sequentially. Each result becomes a tool message.
    for (const call of toolCalls) {
      let result: ToolResult;
      try {
        result = opts.mcpPool?.owns(call.name)
          ? await dispatchMcpCall(opts.mcpPool, call, perms)
          : await dispatchTool(call, perms);
      } catch (err) {
        result = { ok: false, error: `tool dispatch threw: ${(err as Error).message}` };
      }
      // Print a compact result preview.
      const preview = (result.ok ? chalk.green("    ok") : chalk.red(`    ✗ ${result.error}`))
        + (result.truncated ? chalk.dim("  (truncated)") : "");
      console.log(preview);

      messages.push({
        role:         "tool",
        tool_call_id: call.id,
        content:      JSON.stringify({
          ok:        result.ok,
          result:    result.result,
          error:     result.error,
          truncated: result.truncated,
        }),
      });
    }
  }

  console.log("");
  console.log(chalk.yellow(`(hit max-turns ${maxTurns} — stopping)`));
}
