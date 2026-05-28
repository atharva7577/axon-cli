/**
 * `axon whoami` — show the active tenant + key prefix.
 *
 * Round-trips to /v1/stats so the user knows the key still validates against
 * the live backend, not just that the file exists locally.
 */

import chalk from "chalk";
import { Command } from "commander";
import { readConfig } from "../config.js";
import { getJson, AxonBackendError } from "../http.js";

interface StatsResp {
  total_requests:    number;
  cache_hits:        number;
  cache_hit_rate:    string;
  total_cost:        number;
  total_cost_saved:  number;
}

function maskKey(k: string | undefined): string {
  if (!k) return "—";
  if (k.length <= 16) return k;
  return `${k.slice(0, 16)}…${k.slice(-4)}`;
}

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("Show the active tenant and key.")
    .option("--json", "Emit JSON.")
    .action(async (opts: { json?: boolean }) => {
      const cfg = readConfig();
      if (!cfg.apiKey) {
        if (opts.json) {
          console.log(JSON.stringify({ authenticated: false }));
        } else {
          console.log(chalk.yellow("Not logged in.") + " Run " + chalk.bold("axon login") + ".");
        }
        process.exitCode = 1;
        return;
      }

      try {
        const res = await getJson<StatsResp>("/v1/stats", {});
        if (opts.json) {
          console.log(JSON.stringify({
            authenticated: true,
            apiBase:       cfg.apiBase,
            keyPrefix:     maskKey(cfg.apiKey),
            tenantId:      cfg.tenantId ?? null,
            stats:         res.data,
          }, null, 2));
        } else {
          console.log("");
          console.log(`  ${chalk.dim("apiBase:")}    ${cfg.apiBase}`);
          console.log(`  ${chalk.dim("key:")}        ${maskKey(cfg.apiKey)}`);
          console.log(`  ${chalk.dim("tenant:")}     ${cfg.tenantId ?? chalk.dim("(unknown — set with `axon config set tenantId <id>`)")}`);
          console.log(`  ${chalk.dim("telemetry:")}  ${cfg.telemetry ? chalk.green("on") : chalk.yellow("off")}`);
          console.log("");
          console.log(`  ${chalk.green("✓")} Backend reachable. ${chalk.dim(`${res.data.total_requests} requests on record.`)}`);
        }
      } catch (err) {
        if (opts.json) {
          console.log(JSON.stringify({
            authenticated: false,
            apiBase:       cfg.apiBase,
            keyPrefix:     maskKey(cfg.apiKey),
            error:         err instanceof Error ? err.message : String(err),
          }, null, 2));
        } else {
          if (err instanceof AxonBackendError && err.status === 401) {
            console.error(chalk.red("✗ Invalid or revoked key.") + " Run " + chalk.bold("axon login") + " to refresh.");
          } else {
            console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          }
        }
        process.exitCode = 1;
      }
    });
}
