/**
 * `axon repl` — explicit subcommand entry to the REPL.
 *
 * The bare `axon` invocation also lands here once the user is logged in
 * (see ../index.ts). Carrying it as a real subcommand makes it discoverable
 * via `axon --help`.
 */

import chalk from "chalk";
import { Command } from "commander";
import { readConfig } from "../config.js";
import { runRepl } from "../repl.js";

export function registerRepl(program: Command): void {
  program
    .command("repl")
    .description("Start the interactive REPL (also the bare `axon` action when logged in).")
    .action(async () => {
      const cfg = readConfig();
      if (!cfg.apiKey) {
        console.error(chalk.yellow("Not logged in.") + " Run " + chalk.bold("axon login") + " first.");
        process.exitCode = 1;
        return;
      }
      await runRepl();
    });
}
