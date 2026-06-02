/**
 * `axon config get|set|list|path` — manage ~/.axon/config.json from the CLI.
 *
 * Refuses to set fields outside the AxonConfig schema; aliases boolean strings
 * ("on" / "off" / "true" / "false") and the special string "null" to clear a
 * field. apiKey is intentionally NOT writable here — use `axon login` to
 * acquire it (so we always verify against the backend before persisting).
 */

import chalk from "chalk";
import { Command } from "commander";
import { configPath, patchConfig, readConfig, type AxonConfig } from "../config.js";
import { assertSecureBase } from "../http.js";

type ConfigKey = keyof AxonConfig;
const WRITABLE_KEYS: ConfigKey[] = [
  "apiBase",
  "defaultModel",
  "telemetry",
  "adminSecret",
  "tenantId",
];

function isWritable(key: string): key is Exclude<ConfigKey, "apiKey" | "updatedAt"> {
  return (WRITABLE_KEYS as string[]).includes(key);
}

function parseValue(key: string, raw: string): unknown {
  if (key === "telemetry") {
    const v = raw.toLowerCase();
    if (["on", "true", "1", "yes"].includes(v))  return true;
    if (["off", "false", "0", "no"].includes(v)) return false;
    throw new Error(`telemetry must be on|off (got "${raw}")`);
  }
  if (raw === "null" || raw === "") return undefined;
  return raw;
}

function maskKey(k: string | undefined): string {
  if (!k) return "—";
  if (k.length <= 16) return k;
  return `${k.slice(0, 16)}…${k.slice(-4)}`;
}

function maskSecret(s: string | undefined): string {
  if (!s) return "—";
  return `${"*".repeat(Math.min(s.length, 8))}…`;
}

export function registerConfig(program: Command): void {
  const cfg = program.command("config").description("Read or modify ~/.axon/config.json.");

  cfg.command("get [key]")
    .description("Print a single config value, or the whole config when omitted.")
    .action((key?: string) => {
      const c = readConfig();
      if (!key) {
        console.log(JSON.stringify({
          ...c,
          apiKey:      maskKey(c.apiKey),
          adminSecret: maskSecret(c.adminSecret),
        }, null, 2));
        return;
      }
      const value = (c as unknown as Record<string, unknown>)[key];
      if (value === undefined) {
        console.error(chalk.yellow(`(unset)`));
        process.exitCode = 1;
        return;
      }
      if (key === "apiKey")      { console.log(maskKey(value as string));   return; }
      if (key === "adminSecret") { console.log(maskSecret(value as string)); return; }
      console.log(typeof value === "string" ? value : JSON.stringify(value));
    });

  cfg.command("set <key> <value>")
    .description("Persist a value to ~/.axon/config.json (atomic, chmod 600).")
    .action((key: string, value: string) => {
      if (key === "apiKey") {
        console.error(chalk.red("Refusing to set apiKey here.") + " Run " + chalk.bold("axon login") + " — it verifies + persists in one step.");
        process.exitCode = 1;
        return;
      }
      if (!isWritable(key)) {
        console.error(chalk.red(`Unknown config key: ${key}`));
        console.error(chalk.dim(`writable: ${WRITABLE_KEYS.join(", ")}`));
        process.exitCode = 1;
        return;
      }
      let parsed: unknown;
      try { parsed = parseValue(key, value); }
      catch (err) { console.error(chalk.red(`✗ ${(err as Error).message}`)); process.exitCode = 1; return; }
      // Fail fast on an insecure backend URL before persisting it.
      if (key === "apiBase" && typeof parsed === "string") {
        try { assertSecureBase(parsed); }
        catch (err) { console.error(chalk.red(`✗ ${(err as Error).message}`)); process.exitCode = 1; return; }
      }
      patchConfig({ [key]: parsed } as Partial<AxonConfig>);
      console.log(chalk.green("✓") + ` ${key} updated.`);
    });

  cfg.command("list")
    .description("Print the full config (secrets masked).")
    .action(() => {
      const c = readConfig();
      console.log(JSON.stringify({
        ...c,
        apiKey:      maskKey(c.apiKey),
        adminSecret: maskSecret(c.adminSecret),
      }, null, 2));
    });

  cfg.command("path")
    .description("Print the path to the config file.")
    .action(() => {
      console.log(configPath());
    });
}
