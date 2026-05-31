/**
 * `axon chat` — one-shot completion + Unix-pipe.
 *
 * Examples:
 *   axon chat "explain monads"
 *   cat src/foo.ts | axon chat "what does this do?"
 *   echo "ping" | axon chat
 *   axon chat "hello" --json
 *   axon chat "translate" --byok-openai-key sk-…
 *
 * After the stream ends, a dim one-liner shows AXON's routing decision —
 * which model was chosen and why. `--no-meta` suppresses it.
 */

import chalk from "chalk";
import { Command } from "commander";
import { readConfig } from "../config.js";
import { streamChat, type SseFinalChunk } from "../sse.js";
import { AxonBackendError } from "../http.js";
import { runAgentTurn, type ChatMessage } from "../agent.js";
import { PermissionStore } from "../permissions.js";
import { resolveMemory, withMemory } from "../axonmd.js";

interface ChatOpts {
  model?:          string;
  byokOpenaiKey?:  string;
  byokAnthropicKey?: string;
  byokGoogleKey?:  string;
  json?:           boolean;
  meta?:           boolean; // commander's --no-meta sets this to false
  mode?:           "auto" | "coding" | "chat";
  agent?:          boolean; // --agent enables tool-use loop
  maxTurns?:       number;
}

const AGENT_SYSTEM_PROMPT = [
  "You are AXON in one-shot agent mode. The user gave a single prompt and",
  "you have tools (read_file, glob, grep, ls, bash, write_file, edit_file,",
  "web_fetch) to do real work on their machine. Bash/write_file/edit_file/",
  "web_fetch ask for permission before running. Be concise; finish the task",
  "and stop.",
].join(" ");

/**
 * Read stdin if data is being piped in. Race-based detection because
 * `process.stdin.isTTY` and `fstatSync(0)` are both unreliable on Windows
 * (PowerShell pipes report as character devices, not FIFOs and some shells
 * never send `end` even after closing the pipe).
 *
 * Two timers:
 *   • initial-quiet (150ms): no data event ever → assume no pipe, resolve "".
 *   • post-data quiet (1000ms): data arrived but no further chunks AND no end
 *     event → producer is done but didn't close the fd. Resolve with what we have.
 *
 * Either timer cancels when its window is broken (new data extends post-data
 * quiet; explicit `end` resolves immediately).
 */
const STDIN_INITIAL_QUIET_MS = 150;
const STDIN_POST_DATA_QUIET_MS = 1000;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  return new Promise<string>((resolve, reject) => {
    let data = "";
    let timer: NodeJS.Timeout | null = null;
    let sawData = false;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
    };
    const armQuiet = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { cleanup(); resolve(data); }, ms);
    };
    armQuiet(STDIN_INITIAL_QUIET_MS);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      sawData = true;
      armQuiet(STDIN_POST_DATA_QUIET_MS);
    });
    process.stdin.on("end",   () => { cleanup(); resolve(data); });
    process.stdin.on("error", (err) => {
      cleanup();
      if (sawData) resolve(data); else reject(err);
    });
  });
}

function buildPrompt(arg: string, stdin: string): string {
  const a = arg.trim();
  const s = stdin.trim();
  if (a && s) {
    // arg = instruction, stdin = context block. Fence stdin so the model
    // treats it as data rather than as another instruction.
    return `${a}\n\n---\n${s}\n---`;
  }
  return a || s;
}

function formatMetaLine(final: SseFinalChunk): string | null {
  const meta = (final.meta ?? {}) as Record<string, unknown>;
  const model =
    typeof final.model === "string" && final.model.length > 0
      ? final.model
      : (meta.model as string | undefined);
  if (!model) return null;

  const reasons: string[] = [];
  const fastPath = meta.fastPath as string | undefined;
  const routing  = meta.routing  as string | undefined;
  const intent   = meta.intent   as string | undefined;
  if (fastPath) reasons.push(`fast-path ${fastPath}`);
  if (routing)  reasons.push(routing);
  else if (intent) reasons.push(`intent ${intent}`);

  const cost = typeof meta.cost === "number" ? meta.cost : undefined;
  const creditsSaved = typeof meta.creditsSaved === "number" ? meta.creditsSaved : undefined;
  const tail: string[] = [];
  if (typeof cost === "number")         tail.push(`$${cost.toFixed(4)} spent`);
  if (typeof creditsSaved === "number") tail.push(`$${creditsSaved.toFixed(4)} saved`);

  const head = reasons.length > 0 ? `routed ${model} via ${reasons.join(", ")}` : `routed ${model}`;
  return tail.length > 0 ? `${head} (${tail.join(", ")})` : head;
}

async function runChat(promptArg: string, opts: ChatOpts): Promise<void> {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    console.error(chalk.yellow("Not logged in.") + " Run " + chalk.bold("axon login") + " first.");
    process.exitCode = 1;
    return;
  }

  // Collect prompt from arg + stdin.
  const stdin = await readStdin();
  const prompt = buildPrompt(promptArg, stdin);
  if (!prompt) {
    console.error(chalk.red("✗ No prompt. Pass one as an argument or pipe via stdin."));
    process.exitCode = 1;
    return;
  }

  // --agent: route through the multi-turn tool loop instead of the simple stream.
  if (opts.agent) {
    // Inject the AXON.md hierarchy so one-shot agent runs share the same
    // project memory as the REPL. (Plain `axon chat` stays user-only.)
    const memory = resolveMemory();
    const messages: ChatMessage[] = [
      { role: "system", content: withMemory(AGENT_SYSTEM_PROMPT, memory) },
      { role: "user",   content: prompt },
    ];
    const ctl = new AbortController();
    const onSignal = () => ctl.abort(new Error("user cancelled"));
    process.on("SIGINT", onSignal);
    try {
      await runAgentTurn(messages, new PermissionStore(), {
        apiBase:  cfg.apiBase,
        apiKey:   cfg.apiKey,
        model:    opts.model ?? cfg.defaultModel ?? "auto",
        mode:     opts.mode ?? "coding",
        byok: {
          openai:    opts.byokOpenaiKey,
          anthropic: opts.byokAnthropicKey,
          google:    opts.byokGoogleKey,
        },
        signal:   ctl.signal,
        maxTurns: opts.maxTurns ?? 25,
        showMeta: opts.meta !== false,
      });
    } finally {
      process.off("SIGINT", onSignal);
    }
    return;
  }

  const body = {
    model:    opts.model ?? cfg.defaultModel ?? "auto",
    messages: [{ role: "user", content: prompt }],
    stream:   true,
    mode:     opts.mode ?? "chat",
  };

  // Surface Ctrl-C → abort the fetch.
  const ctl = new AbortController();
  const onSignal = () => { ctl.abort(new Error("user cancelled")); };
  process.on("SIGINT", onSignal);

  let final: SseFinalChunk | null = null;
  const collected: string[] = [];

  try {
    const stream = streamChat(body, {
      apiBase: cfg.apiBase,
      apiKey:  cfg.apiKey,
      byok: {
        openai:    opts.byokOpenaiKey,
        anthropic: opts.byokAnthropicKey,
        google:    opts.byokGoogleKey,
      },
      signal: ctl.signal,
    });

    for await (const ev of stream) {
      if (ev.type === "delta") {
        if (opts.json) {
          collected.push(ev.text);
        } else {
          process.stdout.write(ev.text);
        }
      } else if (ev.type === "done") {
        final = ev.final;
      }
    }
  } catch (err) {
    process.off("SIGINT", onSignal);
    if (err instanceof AxonBackendError) {
      if (err.status === 401) {
        console.error("\n" + chalk.red("✗ Invalid or revoked key.") + " Run " + chalk.bold("axon login") + " to refresh.");
      } else {
        console.error("\n" + chalk.red(`✗ ${err.message}`) + chalk.dim(`  (${err.code})`));
      }
    } else {
      console.error("\n" + chalk.red(`✗ ${(err as Error).message ?? err}`));
    }
    process.exitCode = 1;
    return;
  }
  process.off("SIGINT", onSignal);

  if (opts.json) {
    const text = collected.join("");
    const out  = {
      content:  text,
      model:    final?.model,
      usage:    final?.usage,
      meta:     final?.meta,
      code_edit: final?.code_edit,
      extras:   { budget: final?.budget, extra_files: final?.extra_files },
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Streaming mode: ensure trailing newline before the meta line.
  process.stdout.write("\n");
  if (opts.meta !== false && final) {
    const line = formatMetaLine(final);
    if (line) console.log(chalk.dim(`> ${line}`));
  }
}

export function registerChat(program: Command): void {
  program
    .command("chat [prompt...]")
    .description("One-shot completion. Pipe context via stdin.")
    .option("-m, --model <model>",          "Specific model id (default: auto — let AXON route).")
    .option("-M, --mode <mode>",            "Session mode: auto | coding | chat", "chat")
    .option("--byok-openai-key <key>",      "Forward an OpenAI key (header x-openai-key).")
    .option("--byok-anthropic-key <key>",   "Forward an Anthropic key (header x-anthropic-key).")
    .option("--byok-google-key <key>",      "Forward a Google key (header x-google-key).")
    .option("--json",                       "Emit a single JSON blob instead of streaming text.")
    .option("--no-meta",                    "Suppress the routing trace line after the response.")
    .option("--agent",                      "Run as an agent: model can call tools (read/glob/grep/ls/bash/write/edit/web_fetch) to do real work. Adds turn-by-turn permission prompts for mutating tools.")
    .option("--max-turns <n>",              "When --agent: cap LLM round-trips (default 25).", (v: string) => parseInt(v, 10))
    .action(async (promptParts: string[], opts: ChatOpts) => {
      await runChat(promptParts.join(" "), opts);
    });
}

// Exposed so the default action (`axon "prompt"`) can reuse it without
// reaching into commander internals.
export async function runChatDirect(promptArg: string, opts: ChatOpts): Promise<void> {
  return runChat(promptArg, opts);
}
