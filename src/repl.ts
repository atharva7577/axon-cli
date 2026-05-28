/**
 * repl.ts — the bare `axon` interactive loop.
 *
 * Reads lines from readline. A leading `/` opens the slash-command dispatcher;
 * anything else is a chat prompt streamed via /v1/chat/completions stream=true.
 * When the backend returns a code_edit, the REPL renders a colourised diff,
 * fires `edit_proposed`, and waits for the user's `[a]pply / [r]eject / [e]dit`
 * response — which fires `edit_applied + edit_accepted` (a), `edit_rejected`
 * (r), or leaves the pending edit untouched (e) for the user to refine.
 *
 * That accept/reject signal is the moat: every keypress in this REPL feeds
 * back into the same tenant's routing memory.
 */

import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { readConfig } from "./config.js";
import { streamChat, type SseFinalChunk } from "./sse.js";
import { AxonBackendError } from "./http.js";
import {
  AttachedFiles,
  buildPromptWithAttachments,
  type ChatContext,
} from "./context.js";
import { DEFAULT_SESSION_MODE, isSessionMode, type SessionMode } from "./mode.js";
import { PendingEditState } from "./pending.js";
import {
  applyCodeEdit,
  parseCodeEdit,
  revertAppliedEdit,
  validateSearchReplace,
  type CodeEditPayload,
} from "./diff.js";
import { renderSearchReplace, renderUnifiedDiff } from "./render.js";
import { postEditorEvent } from "./telemetry.js";

interface ReplState {
  attached:  AttachedFiles;
  mode:      SessionMode;
  pending:   PendingEditState;
}

function banner(state: ReplState): void {
  console.log("");
  console.log("  " + chalk.bold("AXON") + chalk.dim("  ·  /help for commands, /exit to leave"));
  console.log("  " + chalk.dim(`mode: ${state.mode}  ·  cwd: ${state.attached.workspaceRoot}`));
  console.log("");
}

function helpText(): string {
  return [
    "",
    chalk.bold("commands"),
    `  ${chalk.cyan("/file <path>")}        attach a file (counts toward 32k context cap)`,
    `  ${chalk.cyan("/files <p1> <p2>")}    attach multiple files`,
    `  ${chalk.cyan("/clear")}              detach all files + drop pending edit`,
    `  ${chalk.cyan("/status")}             attached files, mode, pending edit`,
    `  ${chalk.cyan("/mode <auto|coding|chat>")}  toggle session mode`,
    `  ${chalk.cyan("/diff")}               re-show the current pending diff`,
    `  ${chalk.cyan("/apply")} or ${chalk.cyan("a")}        apply the pending edit (fires edit_accepted)`,
    `  ${chalk.cyan("/reject")} or ${chalk.cyan("r")}       reject the pending edit (fires edit_rejected)`,
    `  ${chalk.cyan("/undo")}               revert the last applied edit`,
    `  ${chalk.cyan("/help")}               this list`,
    `  ${chalk.cyan("/exit")} or ${chalk.cyan("Ctrl-D")}   leave the REPL`,
    "",
  ].join("\n");
}

function formatMetaLine(final: SseFinalChunk): string | null {
  const meta = (final.meta ?? {}) as Record<string, unknown>;
  const model = (typeof final.model === "string" && final.model) || (meta.model as string | undefined);
  if (!model) return null;
  const reasons: string[] = [];
  if (meta.fastPath)  reasons.push(`fast-path ${meta.fastPath}`);
  if (meta.routing)   reasons.push(meta.routing as string);
  else if (meta.intent) reasons.push(`intent ${meta.intent}`);
  const tail: string[] = [];
  if (typeof meta.cost         === "number") tail.push(`$${(meta.cost         as number).toFixed(4)} spent`);
  if (typeof meta.creditsSaved === "number") tail.push(`$${(meta.creditsSaved as number).toFixed(4)} saved`);
  const head = reasons.length > 0 ? `routed ${model} via ${reasons.join(", ")}` : `routed ${model}`;
  return tail.length > 0 ? `${head} (${tail.join(", ")})` : head;
}

function getRequestIdFromFinal(final: SseFinalChunk): string {
  const meta = (final.meta ?? {}) as Record<string, unknown>;
  const id = meta.requestId;
  if (typeof id === "string" && id.length > 0) return id;
  return randomUUID();
}

async function runTurn(state: ReplState, userPrompt: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    console.log(chalk.yellow("(not logged in — run `axon login`)"));
    return;
  }

  const prompt = buildPromptWithAttachments(userPrompt, state.attached);
  const ctx: ChatContext | undefined = state.attached.toBackendContext();

  const body: Record<string, unknown> = {
    model:    cfg.defaultModel ?? "auto",
    messages: [{ role: "user", content: prompt }],
    stream:   true,
    mode:     state.mode,
  };
  if (ctx) body.context = ctx;

  const ctl = new AbortController();
  const onSig = () => ctl.abort(new Error("user cancelled"));
  process.on("SIGINT", onSig);

  let final: SseFinalChunk | null = null;
  try {
    for await (const ev of streamChat(body, { apiBase: cfg.apiBase, apiKey: cfg.apiKey, signal: ctl.signal })) {
      if (ev.type === "delta") process.stdout.write(ev.text);
      else if (ev.type === "done") final = ev.final;
    }
  } catch (err) {
    process.off("SIGINT", onSig);
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
  process.off("SIGINT", onSig);
  process.stdout.write("\n");

  if (final) {
    const line = formatMetaLine(final);
    if (line) console.log(chalk.dim(`> ${line}`));
  }

  // Detect a code_edit on the final chunk. The buffered shim hangs the AXON
  // extras on the final SSE chunk; the search-replace payload lives there.
  if (final?.code_edit) {
    const payload = parseCodeEdit({ type: "code_edit", ...(final.code_edit as Record<string, unknown>) });
    if (payload) {
      await handleProposedEdit(state, payload, getRequestIdFromFinal(final));
    }
  }
}

async function handleProposedEdit(state: ReplState, payload: CodeEditPayload, requestId: string): Promise<void> {
  // Pre-validate search-replace placeholders before showing the user a diff
  // we couldn't apply anyway.
  if (!("newContent" in payload)) {
    const v = validateSearchReplace(payload);
    if (!v.valid) {
      console.log(chalk.yellow(`\n(model returned an invalid edit: ${v.reason})`));
      return;
    }
  }

  state.pending.setPending({ payload, requestId, proposedAt: Date.now() });
  await postEditorEvent({ event: "edit_proposed", requestId, filePath: payload.filePath });

  console.log("");
  if ("newContent" in payload) {
    console.log(chalk.bold.cyan(`──── ${payload.filePath} (full-file write) ────`));
    console.log(chalk.dim(`(${payload.newContent.length} chars)`));
  } else {
    console.log(renderSearchReplace(payload.filePath, payload.search, payload.replace));
  }
  console.log(chalk.dim("\n[a]pply / [r]eject / [e]dit  — or send another prompt to refine"));
}

async function cmdApply(state: ReplState): Promise<void> {
  const p = state.pending.getPending();
  if (!p) { console.log(chalk.dim("(nothing pending)")); return; }
  try {
    const applied = await applyCodeEdit(
      "newContent" in p.payload ? { ...p.payload, explicit: true } : p.payload,
      state.attached.workspaceRoot,
    );
    state.pending.setLastApplied(applied, p.requestId);
    state.pending.clearPending();
    await postEditorEvent({ event: "edit_applied",  requestId: p.requestId, filePath: applied.filePath });
    await postEditorEvent({ event: "edit_accepted", requestId: p.requestId, filePath: applied.filePath });
    console.log(chalk.green(`✓ applied ${applied.filePath}`) + chalk.dim(applied.wasNewFile ? "  (new file)" : ""));
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    // Don't clear pending — let the user refine.
  }
}

async function cmdReject(state: ReplState): Promise<void> {
  const p = state.pending.getPending();
  if (!p) { console.log(chalk.dim("(nothing pending)")); return; }
  state.pending.clearPending();
  await postEditorEvent({ event: "edit_rejected", requestId: p.requestId, filePath: p.payload.filePath, method: "command" });
  console.log(chalk.yellow("✗ rejected") + chalk.dim(" — fed back to routing memory"));
}

async function cmdUndo(state: ReplState): Promise<void> {
  const la = state.pending.getLastApplied();
  if (!la) { console.log(chalk.dim("(nothing to undo)")); return; }
  try {
    await revertAppliedEdit(la.applied);
    state.pending.clearLastApplied();
    await postEditorEvent({ event: "edit_rejected", requestId: la.requestId, filePath: la.applied.filePath, method: "undo" });
    console.log(chalk.yellow(`↶ reverted ${la.applied.filePath}`));
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
  }
}

function cmdDiff(state: ReplState): void {
  const p = state.pending.getPending();
  if (!p) { console.log(chalk.dim("(nothing pending)")); return; }
  if ("newContent" in p.payload) {
    console.log(chalk.bold.cyan(`──── ${p.payload.filePath} (full-file write) ────`));
    console.log(chalk.dim(`(${p.payload.newContent.length} chars)`));
  } else {
    // Render a true unified diff against the on-disk content if available.
    try {
      const onDisk = state.attached.list().find((a) => a.path.endsWith(p.payload.filePath))?.content;
      if (onDisk) {
        console.log(renderUnifiedDiff(onDisk, onDisk.replace(p.payload.search, p.payload.replace), { filePath: p.payload.filePath }));
        return;
      }
    } catch { /* fall through */ }
    console.log(renderSearchReplace(p.payload.filePath, p.payload.search, p.payload.replace));
  }
}

function cmdStatus(state: ReplState): void {
  console.log("");
  console.log(`  ${chalk.dim("mode:")}      ${state.mode}`);
  console.log(`  ${chalk.dim("cwd:")}       ${state.attached.workspaceRoot}`);
  console.log(`  ${chalk.dim("attached:")}  ${state.attached.size()} file${state.attached.size() === 1 ? "" : "s"}`);
  for (const f of state.attached.list()) {
    console.log(`    · ${f.relPath} ${chalk.dim(`(${f.bytes}B)`)}`);
  }
  const p = state.pending.getPending();
  if (p) {
    const kind = "newContent" in p.payload ? "full-file" : "search/replace";
    console.log(`  ${chalk.dim("pending:")}   ${p.payload.filePath} ${chalk.dim(`(${kind})`)}`);
  } else {
    console.log(`  ${chalk.dim("pending:")}   ${chalk.dim("(none)")}`);
  }
  const la = state.pending.getLastApplied();
  if (la) console.log(`  ${chalk.dim("undoable:")}  ${la.applied.filePath}`);
  console.log("");
}

async function dispatch(state: ReplState, line: string): Promise<{ exit: boolean }> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { exit: false };

  // Single-letter accept/reject shortcuts when an edit is pending.
  const pendingExists = state.pending.getPending() !== null;
  if (pendingExists && (trimmed === "a" || trimmed === "A")) { await cmdApply(state);  return { exit: false }; }
  if (pendingExists && (trimmed === "r" || trimmed === "R")) { await cmdReject(state); return { exit: false }; }
  if (pendingExists && (trimmed === "e" || trimmed === "E")) {
    console.log(chalk.dim("(pending kept — send a refining prompt to update it)"));
    return { exit: false };
  }

  if (!trimmed.startsWith("/")) {
    await runTurn(state, trimmed);
    return { exit: false };
  }

  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const args = rest.join(" ");

  switch (cmd) {
    case "help":
    case "?":
      console.log(helpText());
      return { exit: false };

    case "exit":
    case "quit":
    case "q":
      return { exit: true };

    case "status":
      cmdStatus(state);
      return { exit: false };

    case "clear":
      state.attached.clear();
      state.pending.clearPending();
      console.log(chalk.dim("(cleared attachments + pending)"));
      return { exit: false };

    case "mode": {
      const m = args.trim();
      if (!m) { console.log(`  current mode: ${state.mode}`); return { exit: false }; }
      if (!isSessionMode(m)) {
        console.log(chalk.red(`✗ unknown mode "${m}" — expected auto | coding | chat`));
        return { exit: false };
      }
      state.mode = m;
      console.log(chalk.dim(`(mode → ${m})`));
      return { exit: false };
    }

    case "file": {
      if (!args) { console.log(chalk.red("✗ /file <path>")); return { exit: false }; }
      try {
        const f = await state.attached.add(args);
        console.log(chalk.dim(`✓ attached ${f.relPath} (${f.bytes}B)`));
      } catch (err) {
        console.log(chalk.red(`✗ ${(err as Error).message}`));
      }
      return { exit: false };
    }

    case "files": {
      const paths = rest.filter(Boolean);
      if (paths.length === 0) { console.log(chalk.red("✗ /files <path1> <path2> …")); return { exit: false }; }
      for (const p of paths) {
        try {
          const f = await state.attached.add(p);
          console.log(chalk.dim(`✓ ${f.relPath} (${f.bytes}B)`));
        } catch (err) {
          console.log(chalk.red(`✗ ${p}: ${(err as Error).message}`));
        }
      }
      return { exit: false };
    }

    case "diff":
      cmdDiff(state);
      return { exit: false };

    case "apply":
      await cmdApply(state);
      return { exit: false };

    case "reject":
      await cmdReject(state);
      return { exit: false };

    case "undo":
      await cmdUndo(state);
      return { exit: false };

    default:
      console.log(chalk.red(`✗ unknown command "/${cmd}" — try /help`));
      return { exit: false };
  }
}

function prompt(rl: Interface): void {
  rl.setPrompt(chalk.bold.green("› "));
  rl.prompt();
}

export async function runRepl(): Promise<void> {
  const state: ReplState = {
    attached: new AttachedFiles(process.cwd()),
    mode:     DEFAULT_SESSION_MODE,
    pending:  new PendingEditState(),
  };
  banner(state);

  // terminal:false when stdin isn't a TTY so the REPL is scriptable for
  // smoke tests (and so PowerShell pipes don't render gibberish). TTY users
  // still get arrow-key history + line editing.
  const rl = createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    historySize: 200,
  });

  prompt(rl);

  for await (const rawLine of rl) {
    try {
      const { exit } = await dispatch(state, rawLine);
      if (exit) break;
    } catch (err) {
      console.error(chalk.red(`✗ ${(err as Error).message ?? err}`));
    }
    prompt(rl);
  }
  rl.close();
  console.log("");
}
