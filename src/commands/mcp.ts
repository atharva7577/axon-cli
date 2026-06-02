/**
 * `axon mcp list|add|remove|serve` — manage external MCP servers + expose AXON.
 *
 *   axon mcp list
 *   axon mcp add <name> [--env K=V]… [--cwd dir] [--disabled] -- <command> [args…]
 *   axon mcp remove <name>
 *   axon mcp serve                 # proxy AXON's own MCP tools over stdio
 *
 * Configured servers are spawned by the REPL / `chat --agent` and their tools
 * are offered to the model as `mcp__<server>__<tool>`, gated per server.
 */

import chalk from "chalk";
import { Command } from "commander";
import {
  addServer, removeServer, listServers, isValidServerName, registryPath, type McpServerSpec,
} from "../mcp/registry.js";
import { runMcpServe } from "../mcp/serve.js";

function collectKV(val: string, prev: string[]): string[] {
  prev.push(val);
  return prev;
}

export function registerMcp(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Manage MCP servers, and expose AXON's tools over MCP (`mcp serve`).");

  mcp.command("list")
    .alias("ls")
    .description("List configured MCP servers.")
    .action(() => {
      const servers = listServers();
      if (servers.length === 0) {
        console.log(chalk.dim("  no MCP servers configured. Add one with:"));
        console.log("    " + chalk.bold("axon mcp add <name> -- npx -y <package>"));
        return;
      }
      console.log("");
      for (const s of servers) {
        const cmd  = [s.command, ...(s.args ?? [])].join(" ");
        const flag = s.disabled ? chalk.dim("[disabled]") : chalk.green("[enabled]");
        console.log(`  ${chalk.cyan(s.name)} ${flag}  ${chalk.dim(cmd)}`);
      }
      console.log("");
      console.log(chalk.dim(`  (${registryPath()})`));
    });

  mcp.command("add <name> [command...]")
    .description("Register an MCP server. Put the launch command after `--`.")
    .option("--env <pair>", "Environment variable KEY=VALUE (repeatable).", collectKV, [])
    .option("--cwd <dir>",  "Working directory for the server process.")
    .option("--disabled",   "Add the server but leave it disabled.")
    .action((name: string, commandParts: string[] | undefined, opts: { env: string[]; cwd?: string; disabled?: boolean }) => {
      if (!isValidServerName(name)) {
        console.error(chalk.red(`✗ invalid server name "${name}" — letters, digits, - and _ only.`));
        process.exitCode = 1;
        return;
      }
      const parts = commandParts ?? [];
      if (parts.length === 0) {
        console.error(chalk.red("✗ no launch command.") + " e.g. " + chalk.bold("axon mcp add tp -- npx -y @modelcontextprotocol/server-sequential-thinking"));
        process.exitCode = 1;
        return;
      }
      const env: Record<string, string> = {};
      for (const kv of opts.env) {
        const i = kv.indexOf("=");
        if (i < 1) {
          console.error(chalk.red(`✗ bad --env "${kv}" — expected KEY=VALUE.`));
          process.exitCode = 1;
          return;
        }
        env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const spec: McpServerSpec = {
        command: parts[0]!,
        ...(parts.length > 1 ? { args: parts.slice(1) } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.disabled ? { disabled: true } : {}),
      };
      try {
        addServer(name, spec);
      } catch (err) {
        console.error(chalk.red(`✗ ${(err as Error).message}`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green("✓") + ` added MCP server ${chalk.bold(name)}: ${chalk.dim([spec.command, ...(spec.args ?? [])].join(" "))}`);
      console.log(chalk.dim("  its tools appear in the REPL / `chat --agent` as ") + chalk.cyan(`mcp__${name}__*`));
    });

  mcp.command("remove <name>")
    .alias("rm")
    .description("Remove a configured MCP server.")
    .action((name: string) => {
      if (removeServer(name)) {
        console.log(chalk.green("✓") + ` removed ${name}`);
      } else {
        console.error(chalk.yellow(`(no MCP server named "${name}")`));
        process.exitCode = 1;
      }
    });

  mcp.command("serve")
    .description("Expose AXON's MCP tools (route_for_intent, …) over stdio for an MCP host.")
    .action(async () => {
      try {
        await runMcpServe();
      } catch (err) {
        console.error(chalk.red(`✗ ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
