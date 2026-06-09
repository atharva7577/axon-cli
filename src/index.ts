/**
 * axon — the terminal client for the AXON routing + execution-memory runtime.
 *
 * M0 commands shipped here:
 *   axon login            device-code flow (or `--key axon_live_…` headless)
 *   axon whoami           show active tenant + verify the key against the backend
 *   axon logout           wipe the stored key
 *   axon stats            tenant request count + cache rate + spend
 *   axon config get|set   manage ~/.axon/config.json
 *
 * M1 (this commit):
 *   axon chat "prompt"    one-shot completion (Unix-pipe via stdin)
 *   axon "prompt"         shorthand for `axon chat`
 *   axon                  first-run wizard (when no apiKey) or help
 */

import chalk from "chalk";
import { Command } from "commander";
import { registerLogin }  from "./commands/login.js";
import { registerWhoami } from "./commands/whoami.js";
import { registerLogout } from "./commands/logout.js";
import { registerStats }  from "./commands/stats.js";
import { registerConfig } from "./commands/config.js";
import { registerChat, runChatDirect } from "./commands/chat.js";
import { registerSkill } from "./commands/skill.js";
import { registerMcp } from "./commands/mcp.js";
import { registerRepl } from "./commands/repl.js";
import { runFirstRun, shouldRunFirstRun } from "./onboarding.js";
import { runRepl } from "./repl.js";
import { readConfig } from "./config.js";

const VERSION = "0.1.2";

// Fail friendly on an unsupported Node instead of a cryptic ESM/runtime error
// deep in a dependency. Floor is 20 (commander@14 + our glob/grep walker).
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (Number.isFinite(NODE_MAJOR) && NODE_MAJOR < 20) {
  process.stderr.write(
    `AXON requires Node.js >= 20 — you have ${process.versions.node}.\n` +
    `Upgrade at https://nodejs.org/ (or via nvm), then reinstall AXON.\n`,
  );
  process.exit(1);
}

const program = new Command();

program
  .name("axon")
  .description("AXON — the terminal client for routing + execution-memory.")
  .version(VERSION, "-v, --version", "Show CLI version.")
  .showHelpAfterError(chalk.dim("(run `axon --help` for command list)"));

registerLogin(program);
registerWhoami(program);
registerLogout(program);
registerStats(program);
registerConfig(program);
registerChat(program);
registerSkill(program);
registerMcp(program);
registerRepl(program);

async function main(): Promise<void> {
  // Bare invocation — three branches, ordered by user value:
  //   1. First-run wizard if no API key on file and we're interactive.
  //   2. Interactive REPL if logged in + interactive TTY.
  //   3. Help if non-interactive (CI, scripts) and no args.
  if (process.argv.length <= 2) {
    if (shouldRunFirstRun()) {
      await runFirstRun();
      return;
    }
    const cfg = readConfig();
    if (cfg.apiKey && process.stdin.isTTY && process.stdout.isTTY) {
      await runRepl();
      return;
    }
    program.outputHelp();
    return;
  }

  // Implicit `axon "prompt"` — when argv[2] doesn't match a known command,
  // treat the joined args as a chat prompt. This mirrors Claude Code's UX
  // where `claude "..."` is the killer shorthand.
  const knownCommands = program.commands.map((c) => c.name());
  const first = process.argv[2];
  const isFlag = first?.startsWith("-");
  if (first && !isFlag && !knownCommands.includes(first)) {
    // Only the user-facing prompt is positional; no other flags supported here.
    // For richer flag support, the user can spell `axon chat "..." --json`.
    const cfg = readConfig();
    if (!cfg.apiKey && shouldRunFirstRun()) {
      await runFirstRun();
      return;
    }
    await runChatDirect(process.argv.slice(2).join(" "), {});
    return;
  }

  await program.parseAsync(process.argv);
}

main().then(
  // Explicit exit: Node's undici fetch keeps connections alive in a pool
  // (~4s timeout), which holds the event loop open after our work is done.
  // For a one-shot CLI we want to terminate as soon as the command returns.
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  },
);
