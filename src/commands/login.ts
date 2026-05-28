/**
 * `axon login` — device-code flow + `--key` headless path.
 *
 * Default flow:
 *   1. POST /v1/auth/device                          → user_code + device_code
 *   2. show user_code, open https://axon.nexalyte.tech/cli in the browser
 *   3. POST /v1/auth/device/poll every `interval` s  → wait for approval
 *   4. on approval, write api_key + tenantId to ~/.axon/config.json
 *
 * Headless flow:
 *   axon login --key axon_live_…
 *     → write the key directly, verify by hitting /v1/stats.
 */

import chalk from "chalk";
import ora from "ora";
import { Command } from "commander";
import { getJson, postJson, AxonBackendError } from "../http.js";
import { patchConfig, readConfig } from "../config.js";
import { openBrowser } from "../browser.js";

interface DeviceMint {
  device_code:      string;
  user_code:        string;
  verification_uri: string;
  expires_in:       number;
  interval:         number;
}

interface PollResp {
  status:   "pending" | "approved" | "expired" | "consumed";
  api_key?: string;
}

const TELEMETRY_NOTICE =
  "AXON learns from your accept/reject decisions to route your future requests.\n" +
  "Your prompts and edits stay on your tenant. Routing improves only for you.\n" +
  `Disable any time: ${chalk.bold("axon config set telemetry off")}`;

function maskKey(k: string | undefined): string {
  if (!k) return "—";
  if (k.length <= 12) return k;
  return `${k.slice(0, 12)}…${k.slice(-4)}`;
}

async function verifyKey(apiKey: string, apiBase: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await getJson<{ total_requests: number }>("/v1/stats", {
      cfg: { ...readConfig(), apiBase, apiKey, defaultModel: "auto", telemetry: true },
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AxonBackendError) {
      if (err.status === 401) return { ok: false, reason: "invalid or revoked key" };
      return { ok: false, reason: `backend ${err.status}: ${err.message}` };
    }
    return { ok: false, reason: (err as Error).message };
  }
}

export async function runDeviceCodeFlow(apiBase: string, opts: { noBrowser?: boolean }): Promise<void> {
  // 1. Mint a device code.
  const mintSpinner = ora("Requesting device code…").start();
  let mint: DeviceMint;
  try {
    const res = await postJson<DeviceMint>("/v1/auth/device", {}, {
      cfg:       { ...readConfig(), apiBase, defaultModel: "auto", telemetry: true },
      auth:      false,
      timeoutMs: 15_000,
    });
    mint = res.data;
  } catch (err) {
    mintSpinner.fail("Could not reach the AXON backend.");
    throw err;
  }
  mintSpinner.succeed("Device code minted.");

  // 2. Show the user_code + open the browser.
  const browserOpened = opts.noBrowser ? false : openBrowser(mint.verification_uri);
  console.log("");
  console.log(`  ${chalk.dim("Open this URL:")}    ${chalk.cyan(mint.verification_uri)}${browserOpened ? chalk.dim("  (opened for you)") : ""}`);
  console.log(`  ${chalk.dim("Enter this code:")}  ${chalk.bold.green(mint.user_code)}`);
  console.log("");

  // 3. Poll until approved or expired.
  const pollSpinner = ora("Waiting for approval in the browser…").start();
  const deadline    = Date.now() + (mint.expires_in * 1000);
  let approvedKey: string | undefined;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, mint.interval * 1000));
    try {
      const res = await postJson<PollResp>("/v1/auth/device/poll", { device_code: mint.device_code }, {
        cfg: { ...readConfig(), apiBase, defaultModel: "auto", telemetry: true },
        auth: false,
        timeoutMs: 10_000,
      });
      if (res.data.status === "approved" && res.data.api_key) {
        approvedKey = res.data.api_key;
        break;
      }
      if (res.data.status === "expired") {
        pollSpinner.fail("Code expired. Run `axon login` again.");
        process.exitCode = 1;
        return;
      }
      if (res.data.status === "consumed") {
        pollSpinner.fail("Code already used. Run `axon login` again.");
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      // Transient network errors — keep polling until the deadline.
      if (err instanceof AxonBackendError && err.status >= 500) continue;
      // 4xx is structural, stop.
      if (err instanceof AxonBackendError) {
        pollSpinner.fail(`Backend error: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      // Network blip — keep going.
    }
  }

  if (!approvedKey) {
    pollSpinner.fail("Timed out. Run `axon login` again.");
    process.exitCode = 1;
    return;
  }
  pollSpinner.succeed("Approved.");

  // 4. Verify + persist.
  const verifySpinner = ora("Verifying the key…").start();
  const verified = await verifyKey(approvedKey, apiBase);
  if (!verified.ok) {
    verifySpinner.fail(`Key verification failed: ${verified.reason}`);
    process.exitCode = 1;
    return;
  }
  verifySpinner.succeed("Verified.");

  const previous = readConfig();
  patchConfig({ apiBase, apiKey: approvedKey });
  console.log("");
  console.log(chalk.green(`  ✓ Logged in. Key ${maskKey(approvedKey)} saved to ${chalk.dim("~/.axon/config.json")}.`));

  if (previous.telemetry !== false) {
    console.log("");
    console.log(chalk.dim(TELEMETRY_NOTICE));
  }
}

export async function runHeadlessKeyFlow(apiBase: string, apiKey: string): Promise<void> {
  const spinner = ora("Verifying the key…").start();
  const verified = await verifyKey(apiKey, apiBase);
  if (!verified.ok) {
    spinner.fail(`Key verification failed: ${verified.reason}`);
    process.exitCode = 1;
    return;
  }
  spinner.succeed("Verified.");
  patchConfig({ apiBase, apiKey });
  console.log(chalk.green(`  ✓ Logged in. Key ${maskKey(apiKey)} saved to ${chalk.dim("~/.axon/config.json")}.`));
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Authenticate the CLI with the AXON backend.")
    .option("-k, --key <axon_key>",   "Paste an existing AXON API key (skip device-code flow).")
    .option("-b, --base <url>",        "Override the AXON backend base URL.", "")
    .option("--no-browser",            "Do not auto-open the browser. Useful in SSH/headless shells.")
    .action(async (opts: { key?: string; base?: string; browser: boolean }) => {
      const cfg     = readConfig();
      const apiBase = (opts.base?.trim() || cfg.apiBase);
      try {
        if (opts.key && opts.key.trim()) {
          await runHeadlessKeyFlow(apiBase, opts.key.trim());
        } else {
          await runDeviceCodeFlow(apiBase, { noBrowser: !opts.browser });
        }
      } catch (err) {
        if (err instanceof AxonBackendError) {
          console.error(chalk.red(`✗ ${err.message}`));
        } else {
          console.error(chalk.red(`✗ ${(err as Error).message ?? err}`));
        }
        process.exitCode = 1;
      }
    });
}
