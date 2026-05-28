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
import chalk from "chalk";
import { readConfig } from "./config.js";
import { AttachedFiles, buildPromptWithAttachments } from "./context.js";
import { DEFAULT_SESSION_MODE, isSessionMode, type SessionMode } from "./mode.js";
import { PendingEditState } from "./pending.js";
import {
  applyCodeEdit,
  revertAppliedEdit,
} from "./diff.js";
import { postEditorEvent } from "./telemetry.js";
import { PermissionStore } from "./permissions.js";
import { runAgentTurn, type ChatMessage } from "./agent.js";

const SYSTEM_PROMPT = [
  "You are AXON, a terminal-native coding assistant running on the user's machine.",
  "You have full filesystem access via tools: read_file, glob, grep, ls, bash, write_file,",
  "edit_file, web_fetch. Bash/write_file/edit_file/web_fetch require user permission per call.",
  "Always prefer the read-only tools when you only need to look around. Read the relevant",
  "files BEFORE you answer questions about the codebase — never refuse with \"I can't access",
  "files\" because you absolutely can. Be concise and direct.",
].join(" ");

interface ReplState {
  attached:  AttachedFiles;
  mode:      SessionMode;
  pending:   PendingEditState;
  messages:  ChatMessage[];
  perms:     PermissionStore;
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
    chalk.bold("how to use"),
    `  Just type. The model has tools to read files, glob, grep, ls, run`,
    `  shell commands, write/edit files, and fetch URLs. Mutating tools`,
    `  (bash / write / edit / web_fetch) ask for permission per call.`,
    "",
    chalk.bold("slash commands"),
    `  ${chalk.cyan("/file <path>")}        attach a file (counts toward 32k context cap)`,
    `  ${chalk.cyan("/files <p1> <p2>")}    attach multiple files`,
    `  ${chalk.cyan("/clear")}              detach files + reset conversation + drop pending edit`,
    `  ${chalk.cyan("/status")}             attached files, mode, pending edit, turn count`,
    `  ${chalk.cyan("/mode <auto|coding|chat>")}  toggle session mode`,
    `  ${chalk.cyan("/apply")} or ${chalk.cyan("a")}        apply a legacy pending edit (M2 code_edit path)`,
    `  ${chalk.cyan("/reject")} or ${chalk.cyan("r")}       reject the pending edit`,
    `  ${chalk.cyan("/undo")}               revert the last applied edit`,
    `  ${chalk.cyan("/help")}               this list`,
    `  ${chalk.cyan("/exit")} or ${chalk.cyan("Ctrl-D")}   leave the REPL`,
    "",
  ].join("\n");
}

async function runTurn(state: ReplState, userPrompt: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    console.log(chalk.yellow("(not logged in — run `axon login`)"));
    return;
  }

  // Seed the system prompt on the first turn.
  if (state.messages.length === 0) {
    state.messages.push({ role: "system", content: SYSTEM_PROMPT });
  }
  state.messages.push({
    role:    "user",
    content: buildPromptWithAttachments(userPrompt, state.attached),
  });

  const ctl = new AbortController();
  const onSig = () => ctl.abort(new Error("user cancelled"));
  process.on("SIGINT", onSig);

  try {
    await runAgentTurn(state.messages, state.perms, {
      apiBase:  cfg.apiBase,
      apiKey:   cfg.apiKey,
      model:    cfg.defaultModel ?? "auto",
      mode:     state.mode,
      signal:   ctl.signal,
      maxTurns: 25,
      showMeta: true,
    });
  } finally {
    process.off("SIGINT", onSig);
  }
}

// Kept as an explicit /apply path for the legacy code_edit flow; the agent
// loop's edit_file tool handles this end-to-end now, but the slash command
// stays for users who set up a pending edit via the old path.
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

function cmdStatus(state: ReplState): void {
  // System message doesn't count as a "turn" — subtract it when present.
  const turnCount = Math.max(0, state.messages.filter((m) => m.role !== "system").length);
  console.log("");
  console.log(`  ${chalk.dim("mode:")}      ${state.mode}`);
  console.log(`  ${chalk.dim("cwd:")}       ${state.attached.workspaceRoot}`);
  console.log(`  ${chalk.dim("turns:")}     ${turnCount} message${turnCount === 1 ? "" : "s"} in history`);
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
      state.messages.length = 0;
      console.log(chalk.dim("(cleared attachments + conversation + pending)"));
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
    messages: [],
    perms:    new PermissionStore(),
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
