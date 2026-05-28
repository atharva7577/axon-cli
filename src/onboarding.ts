/**
 * First-run welcome wizard.
 *
 * Triggered when the user runs `axon` with no args AND no API key on file
 * (and stdin/stdout are TTYs — we never block on prompts in pipelines).
 *
 * Mirrors the Claude Code first-run UX: a tight welcome, then a single
 * arrow-key picker that routes to the right action. No model picker, no
 * profile setup — AXON's per-tenant memory + routing makes those
 * server-side concerns, not client-side config.
 */

import chalk from "chalk";
import prompts from "prompts";
import { runDeviceCodeFlow, runHeadlessKeyFlow } from "./commands/login.js";
import { readConfig } from "./config.js";
import { openBrowser } from "./browser.js";

function banner(): void {
  // Keep this short — Claude Code's welcome is two lines.
  console.log("");
  console.log("  " + chalk.bold("AXON") + chalk.dim("  ·  the operating layer for AI agents"));
  console.log("  " + chalk.dim("run · route · remember · spend"));
  console.log("");
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.AXON_NO_PROMPT !== "1";
}

/**
 * Decide whether to run the first-run wizard. We only show it when the user
 * is genuinely starting fresh — no apiKey on file, in an interactive shell,
 * not in CI, not in a pipeline.
 */
export function shouldRunFirstRun(): boolean {
  if (!isInteractive()) return false;
  if (process.env.CI === "true") return false;
  const cfg = readConfig();
  return !cfg.apiKey;
}

/**
 * Entry point. Called from index.ts when `axon` is run with no args + no
 * auth. Returns when the wizard finishes (whether or not the user logged in).
 */
export async function runFirstRun(): Promise<void> {
  banner();
  console.log("  " + chalk.dim("Looks like this is your first AXON session."));
  console.log("  " + chalk.dim("Let's get you authenticated — pick one:"));
  console.log("");

  const response = await prompts({
    type:    "select",
    name:    "method",
    message: "How would you like to log in?",
    choices: [
      {
        title:       "Sign in via browser",
        description: "Opens axon.nexalyte.tech/cli and waits for approval. Recommended.",
        value:       "browser",
      },
      {
        title:       "Paste an existing AXON API key",
        description: "Headless — for CI, SSH, or if you already have a key in hand.",
        value:       "paste",
      },
      {
        title:       "I don't have a key yet",
        description: "Opens the waitlist. Come back and run `axon login` once you're in.",
        value:       "waitlist",
      },
    ],
    initial: 0,
  }, {
    onCancel: () => { /* user hit Ctrl-C — fall through to no-op */ },
  });

  const cfg = readConfig();

  switch (response.method) {
    case "browser":
      console.log("");
      await runDeviceCodeFlow(cfg.apiBase, { noBrowser: false });
      return;

    case "paste": {
      const keyResp = await prompts({
        type:     "password",
        name:     "key",
        message:  "Paste your AXON API key (axon_live_… or axon_test_…):",
        validate: (v: string) => v.trim().startsWith("axon_") ? true : "Must start with axon_",
      });
      if (!keyResp.key) {
        console.log(chalk.dim("  (cancelled)"));
        return;
      }
      console.log("");
      await runHeadlessKeyFlow(cfg.apiBase, keyResp.key.trim());
      return;
    }

    case "waitlist": {
      const url = "https://axon.nexalyte.tech";
      const opened = openBrowser(url);
      console.log("");
      console.log("  " + chalk.cyan(url) + (opened ? chalk.dim("  (opened for you)") : ""));
      console.log("  " + chalk.dim("Claim a seat. Once approved you'll receive an AXON API key — paste it via `axon login --key`."));
      return;
    }

    default:
      // User hit Ctrl-C or arrow-key cancel — just exit cleanly.
      console.log(chalk.dim("  (no changes)"));
      return;
  }
}
