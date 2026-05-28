/**
 * `axon logout` — wipe the API key and tenant binding from ~/.axon/config.json.
 *
 * apiBase, defaultModel, telemetry are preserved so the next `axon login`
 * hits the same backend without re-flagging.
 */

import chalk from "chalk";
import { Command } from "commander";
import { clearAuth, readConfig } from "../config.js";

export function registerLogout(program: Command): void {
  program
    .command("logout")
    .description("Clear the stored API key.")
    .action(() => {
      const before = readConfig();
      clearAuth();
      if (before.apiKey) {
        console.log(chalk.green("✓ Logged out.") + chalk.dim(" Run `axon login` to re-authenticate."));
      } else {
        console.log(chalk.dim("Already logged out."));
      }
    });
}
