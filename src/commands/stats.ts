/**
 * `axon stats` — quick view of tenant request count + cache hit rate + spend.
 *
 * Wraps GET /v1/stats. Tenants see their own rows; the synthetic 'global'
 * tenant (env-var fallback) sees everything.
 */

import chalk from "chalk";
import ora from "ora";
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

export function registerStats(program: Command): void {
  program
    .command("stats")
    .description("Show tenant request count, cache rate, and spend.")
    .option("--json", "Emit JSON.")
    .action(async (opts: { json?: boolean }) => {
      const cfg = readConfig();
      if (!cfg.apiKey) {
        console.error(chalk.yellow("Not logged in.") + " Run " + chalk.bold("axon login") + " first.");
        process.exitCode = 1;
        return;
      }
      const spinner = opts.json ? null : ora("Fetching stats…").start();
      try {
        const res = await getJson<StatsResp>("/v1/stats", {});
        if (spinner) spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        const s = res.data;
        console.log("");
        console.log(`  ${chalk.dim("requests:")}        ${chalk.bold(s.total_requests.toString())}`);
        console.log(`  ${chalk.dim("cache hits:")}      ${s.cache_hits} ${chalk.dim(`(${s.cache_hit_rate})`)}`);
        console.log(`  ${chalk.dim("spend:")}           ${chalk.bold(`$${s.total_cost.toFixed(4)}`)}`);
        console.log(`  ${chalk.dim("savings:")}         ${chalk.green(`$${s.total_cost_saved.toFixed(4)}`)}`);
        console.log("");
      } catch (err) {
        if (spinner) spinner.fail("Could not fetch stats.");
        if (err instanceof AxonBackendError && err.status === 401) {
          console.error(chalk.red("✗ Invalid or revoked key.") + " Run " + chalk.bold("axon login") + " to refresh.");
        } else {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        }
        process.exitCode = 1;
      }
    });
}
