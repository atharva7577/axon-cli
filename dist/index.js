#!/usr/bin/env node

// src/index.ts
import chalk11 from "chalk";
import { Command } from "commander";

// src/commands/login.ts
import chalk from "chalk";
import ora from "ora";

// src/config.ts
import { existsSync, chmodSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var DEFAULTS = {
  apiBase: "https://api.axon.nexalyte.tech",
  defaultModel: "auto",
  telemetry: true
};
function configDir() {
  return process.env.AXON_CONFIG_DIR?.trim() || join(homedir(), ".axon");
}
function configPath() {
  return join(configDir(), "config.json");
}
function readConfig() {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    throw new Error(`config: ${path} is unreadable (${err.message}). Delete it or fix the JSON.`);
  }
}
function writeConfig(next) {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 448 });
  const path = configPath();
  const tmp = `${path}.tmp`;
  const payload = { ...next, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 384 });
  try {
    chmodSync(tmp, 384);
  } catch {
  }
  try {
    unlinkSync(path);
  } catch {
  }
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 384 });
  try {
    chmodSync(path, 384);
  } catch {
  }
  try {
    unlinkSync(tmp);
  } catch {
  }
}
function patchConfig(patch) {
  const current = readConfig();
  const next = { ...current, ...patch };
  if (!next.apiBase) next.apiBase = DEFAULTS.apiBase;
  if (!next.defaultModel) next.defaultModel = DEFAULTS.defaultModel;
  writeConfig(next);
  return next;
}
function clearAuth() {
  const current = readConfig();
  const { apiKey: _k, tenantId: _t, adminSecret: _s, ...rest } = current;
  const next = { ...DEFAULTS, ...rest };
  writeConfig(next);
  return next;
}

// src/http.ts
var AxonBackendError = class extends Error {
  status;
  code;
  type;
  provider;
  raw;
  constructor(opts) {
    super(opts.message);
    this.name = "AxonBackendError";
    this.status = opts.status;
    this.code = opts.code;
    this.type = opts.type;
    this.provider = opts.provider;
    this.raw = opts.raw;
  }
};
function trimBase(base) {
  return base.replace(/\/+$/, "");
}
function buildHeaders(cfg, opts) {
  const h = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": `axon-cli/${process.env.npm_package_version ?? "dev"} node/${process.versions.node}`
  };
  if (opts.admin) {
    if (!cfg.adminSecret) throw new Error("admin requested but no adminSecret in config. Run `axon config set adminSecret <secret>`.");
    h["X-Admin-Secret"] = cfg.adminSecret;
  } else if (opts.auth !== false && cfg.apiKey) {
    h["Authorization"] = `Bearer ${cfg.apiKey}`;
  }
  return { ...h, ...opts.headers ?? {} };
}
async function parseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function toBackendError(status, body) {
  const err = body?.error ?? {};
  return new AxonBackendError({
    status,
    code: err.code ?? `http_${status}`,
    type: err.type ?? "server_error",
    message: err.message ?? `HTTP ${status}`,
    provider: err.provider,
    raw: body
  });
}
async function send(method, path, body, opts) {
  const cfg = opts.cfg ?? readConfig();
  const base = trimBase(cfg.apiBase);
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = buildHeaders(cfg, opts);
  const ctl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 3e4;
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ctl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: ctl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    throw err;
  }
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  const parsed = await parseBody(res);
  if (!res.ok) throw toBackendError(res.status, parsed);
  return { data: parsed, status: res.status, raw: res };
}
function getJson(path, opts = {}) {
  return send("GET", path, void 0, opts);
}
function postJson(path, body, opts = {}) {
  return send("POST", path, body, opts);
}

// src/browser.ts
import { spawn } from "child_process";
function openBrowser(url) {
  if (process.env.AXON_NO_BROWSER === "1" || process.env.CI === "true") return false;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// src/commands/login.ts
var TELEMETRY_NOTICE = `AXON learns from your accept/reject decisions to route your future requests.
Your prompts and edits stay on your tenant. Routing improves only for you.
Disable any time: ${chalk.bold("axon config set telemetry off")}`;
function maskKey(k) {
  if (!k) return "\u2014";
  if (k.length <= 12) return k;
  return `${k.slice(0, 12)}\u2026${k.slice(-4)}`;
}
async function verifyKey(apiKey, apiBase) {
  try {
    await getJson("/v1/stats", {
      cfg: { ...readConfig(), apiBase, apiKey, defaultModel: "auto", telemetry: true }
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AxonBackendError) {
      if (err.status === 401) return { ok: false, reason: "invalid or revoked key" };
      return { ok: false, reason: `backend ${err.status}: ${err.message}` };
    }
    return { ok: false, reason: err.message };
  }
}
async function runDeviceCodeFlow(apiBase, opts) {
  const mintSpinner = ora("Requesting device code\u2026").start();
  let mint;
  try {
    const res = await postJson("/v1/auth/device", {}, {
      cfg: { ...readConfig(), apiBase, defaultModel: "auto", telemetry: true },
      auth: false,
      timeoutMs: 15e3
    });
    mint = res.data;
  } catch (err) {
    mintSpinner.fail("Could not reach the AXON backend.");
    throw err;
  }
  mintSpinner.succeed("Device code minted.");
  const browserOpened = opts.noBrowser ? false : openBrowser(mint.verification_uri);
  console.log("");
  console.log(`  ${chalk.dim("Open this URL:")}    ${chalk.cyan(mint.verification_uri)}${browserOpened ? chalk.dim("  (opened for you)") : ""}`);
  console.log(`  ${chalk.dim("Enter this code:")}  ${chalk.bold.green(mint.user_code)}`);
  console.log("");
  const pollSpinner = ora("Waiting for approval in the browser\u2026").start();
  const deadline = Date.now() + mint.expires_in * 1e3;
  let approvedKey;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, mint.interval * 1e3));
    try {
      const res = await postJson("/v1/auth/device/poll", { device_code: mint.device_code }, {
        cfg: { ...readConfig(), apiBase, defaultModel: "auto", telemetry: true },
        auth: false,
        timeoutMs: 1e4
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
      if (err instanceof AxonBackendError && err.status >= 500) continue;
      if (err instanceof AxonBackendError) {
        pollSpinner.fail(`Backend error: ${err.message}`);
        process.exitCode = 1;
        return;
      }
    }
  }
  if (!approvedKey) {
    pollSpinner.fail("Timed out. Run `axon login` again.");
    process.exitCode = 1;
    return;
  }
  pollSpinner.succeed("Approved.");
  const verifySpinner = ora("Verifying the key\u2026").start();
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
  console.log(chalk.green(`  \u2713 Logged in. Key ${maskKey(approvedKey)} saved to ${chalk.dim("~/.axon/config.json")}.`));
  if (previous.telemetry !== false) {
    console.log("");
    console.log(chalk.dim(TELEMETRY_NOTICE));
  }
}
async function runHeadlessKeyFlow(apiBase, apiKey) {
  const spinner = ora("Verifying the key\u2026").start();
  const verified = await verifyKey(apiKey, apiBase);
  if (!verified.ok) {
    spinner.fail(`Key verification failed: ${verified.reason}`);
    process.exitCode = 1;
    return;
  }
  spinner.succeed("Verified.");
  patchConfig({ apiBase, apiKey });
  console.log(chalk.green(`  \u2713 Logged in. Key ${maskKey(apiKey)} saved to ${chalk.dim("~/.axon/config.json")}.`));
}
function registerLogin(program2) {
  program2.command("login").description("Authenticate the CLI with the AXON backend.").option("-k, --key <axon_key>", "Paste an existing AXON API key (skip device-code flow).").option("-b, --base <url>", "Override the AXON backend base URL.", "").option("--no-browser", "Do not auto-open the browser. Useful in SSH/headless shells.").action(async (opts) => {
    const cfg = readConfig();
    const apiBase = opts.base?.trim() || cfg.apiBase;
    try {
      if (opts.key && opts.key.trim()) {
        await runHeadlessKeyFlow(apiBase, opts.key.trim());
      } else {
        await runDeviceCodeFlow(apiBase, { noBrowser: !opts.browser });
      }
    } catch (err) {
      if (err instanceof AxonBackendError) {
        console.error(chalk.red(`\u2717 ${err.message}`));
      } else {
        console.error(chalk.red(`\u2717 ${err.message ?? err}`));
      }
      process.exitCode = 1;
    }
  });
}

// src/commands/whoami.ts
import chalk2 from "chalk";
function maskKey2(k) {
  if (!k) return "\u2014";
  if (k.length <= 16) return k;
  return `${k.slice(0, 16)}\u2026${k.slice(-4)}`;
}
function registerWhoami(program2) {
  program2.command("whoami").description("Show the active tenant and key.").option("--json", "Emit JSON.").action(async (opts) => {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      if (opts.json) {
        console.log(JSON.stringify({ authenticated: false }));
      } else {
        console.log(chalk2.yellow("Not logged in.") + " Run " + chalk2.bold("axon login") + ".");
      }
      process.exitCode = 1;
      return;
    }
    try {
      const res = await getJson("/v1/stats", {});
      if (opts.json) {
        console.log(JSON.stringify({
          authenticated: true,
          apiBase: cfg.apiBase,
          keyPrefix: maskKey2(cfg.apiKey),
          tenantId: cfg.tenantId ?? null,
          stats: res.data
        }, null, 2));
      } else {
        console.log("");
        console.log(`  ${chalk2.dim("apiBase:")}    ${cfg.apiBase}`);
        console.log(`  ${chalk2.dim("key:")}        ${maskKey2(cfg.apiKey)}`);
        console.log(`  ${chalk2.dim("tenant:")}     ${cfg.tenantId ?? chalk2.dim("(unknown \u2014 set with `axon config set tenantId <id>`)")}`);
        console.log(`  ${chalk2.dim("telemetry:")}  ${cfg.telemetry ? chalk2.green("on") : chalk2.yellow("off")}`);
        console.log("");
        console.log(`  ${chalk2.green("\u2713")} Backend reachable. ${chalk2.dim(`${res.data.total_requests} requests on record.`)}`);
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({
          authenticated: false,
          apiBase: cfg.apiBase,
          keyPrefix: maskKey2(cfg.apiKey),
          error: err instanceof Error ? err.message : String(err)
        }, null, 2));
      } else {
        if (err instanceof AxonBackendError && err.status === 401) {
          console.error(chalk2.red("\u2717 Invalid or revoked key.") + " Run " + chalk2.bold("axon login") + " to refresh.");
        } else {
          console.error(chalk2.red(`\u2717 ${err instanceof Error ? err.message : String(err)}`));
        }
      }
      process.exitCode = 1;
    }
  });
}

// src/commands/logout.ts
import chalk3 from "chalk";
function registerLogout(program2) {
  program2.command("logout").description("Clear the stored API key.").action(() => {
    const before = readConfig();
    clearAuth();
    if (before.apiKey) {
      console.log(chalk3.green("\u2713 Logged out.") + chalk3.dim(" Run `axon login` to re-authenticate."));
    } else {
      console.log(chalk3.dim("Already logged out."));
    }
  });
}

// src/commands/stats.ts
import chalk4 from "chalk";
import ora2 from "ora";
function registerStats(program2) {
  program2.command("stats").description("Show tenant request count, cache rate, and spend.").option("--json", "Emit JSON.").action(async (opts) => {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      console.error(chalk4.yellow("Not logged in.") + " Run " + chalk4.bold("axon login") + " first.");
      process.exitCode = 1;
      return;
    }
    const spinner = opts.json ? null : ora2("Fetching stats\u2026").start();
    try {
      const res = await getJson("/v1/stats", {});
      if (spinner) spinner.stop();
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const s = res.data;
      console.log("");
      console.log(`  ${chalk4.dim("requests:")}        ${chalk4.bold(s.total_requests.toString())}`);
      console.log(`  ${chalk4.dim("cache hits:")}      ${s.cache_hits} ${chalk4.dim(`(${s.cache_hit_rate})`)}`);
      console.log(`  ${chalk4.dim("spend:")}           ${chalk4.bold(`$${s.total_cost.toFixed(4)}`)}`);
      console.log(`  ${chalk4.dim("savings:")}         ${chalk4.green(`$${s.total_cost_saved.toFixed(4)}`)}`);
      console.log("");
    } catch (err) {
      if (spinner) spinner.fail("Could not fetch stats.");
      if (err instanceof AxonBackendError && err.status === 401) {
        console.error(chalk4.red("\u2717 Invalid or revoked key.") + " Run " + chalk4.bold("axon login") + " to refresh.");
      } else {
        console.error(chalk4.red(`\u2717 ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exitCode = 1;
    }
  });
}

// src/commands/config.ts
import chalk5 from "chalk";
var WRITABLE_KEYS = [
  "apiBase",
  "defaultModel",
  "telemetry",
  "adminSecret",
  "tenantId"
];
function isWritable(key) {
  return WRITABLE_KEYS.includes(key);
}
function parseValue(key, raw) {
  if (key === "telemetry") {
    const v = raw.toLowerCase();
    if (["on", "true", "1", "yes"].includes(v)) return true;
    if (["off", "false", "0", "no"].includes(v)) return false;
    throw new Error(`telemetry must be on|off (got "${raw}")`);
  }
  if (raw === "null" || raw === "") return void 0;
  return raw;
}
function maskKey3(k) {
  if (!k) return "\u2014";
  if (k.length <= 16) return k;
  return `${k.slice(0, 16)}\u2026${k.slice(-4)}`;
}
function maskSecret(s) {
  if (!s) return "\u2014";
  return `${"*".repeat(Math.min(s.length, 8))}\u2026`;
}
function registerConfig(program2) {
  const cfg = program2.command("config").description("Read or modify ~/.axon/config.json.");
  cfg.command("get [key]").description("Print a single config value, or the whole config when omitted.").action((key) => {
    const c = readConfig();
    if (!key) {
      console.log(JSON.stringify({
        ...c,
        apiKey: maskKey3(c.apiKey),
        adminSecret: maskSecret(c.adminSecret)
      }, null, 2));
      return;
    }
    const value = c[key];
    if (value === void 0) {
      console.error(chalk5.yellow(`(unset)`));
      process.exitCode = 1;
      return;
    }
    if (key === "apiKey") {
      console.log(maskKey3(value));
      return;
    }
    if (key === "adminSecret") {
      console.log(maskSecret(value));
      return;
    }
    console.log(typeof value === "string" ? value : JSON.stringify(value));
  });
  cfg.command("set <key> <value>").description("Persist a value to ~/.axon/config.json (atomic, chmod 600).").action((key, value) => {
    if (key === "apiKey") {
      console.error(chalk5.red("Refusing to set apiKey here.") + " Run " + chalk5.bold("axon login") + " \u2014 it verifies + persists in one step.");
      process.exitCode = 1;
      return;
    }
    if (!isWritable(key)) {
      console.error(chalk5.red(`Unknown config key: ${key}`));
      console.error(chalk5.dim(`writable: ${WRITABLE_KEYS.join(", ")}`));
      process.exitCode = 1;
      return;
    }
    let parsed;
    try {
      parsed = parseValue(key, value);
    } catch (err) {
      console.error(chalk5.red(`\u2717 ${err.message}`));
      process.exitCode = 1;
      return;
    }
    patchConfig({ [key]: parsed });
    console.log(chalk5.green("\u2713") + ` ${key} updated.`);
  });
  cfg.command("list").description("Print the full config (secrets masked).").action(() => {
    const c = readConfig();
    console.log(JSON.stringify({
      ...c,
      apiKey: maskKey3(c.apiKey),
      adminSecret: maskSecret(c.adminSecret)
    }, null, 2));
  });
  cfg.command("path").description("Print the path to the config file.").action(() => {
    console.log(configPath());
  });
}

// src/commands/chat.ts
import chalk6 from "chalk";

// src/sse.ts
async function* streamChat(body, options) {
  const cfg = readConfig();
  const apiBase = (options.apiBase || cfg.apiBase).replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": `axon-cli/${process.env.npm_package_version ?? "dev"} node/${process.versions.node}`
  };
  if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;
  if (options.byok?.openai) headers["x-openai-key"] = options.byok.openai;
  if (options.byok?.anthropic) headers["x-anthropic-key"] = options.byok.anthropic;
  if (options.byok?.google) headers["x-google-key"] = options.byok.google;
  const payload = { ...body, stream: true };
  const ctl = new AbortController();
  const timeoutMs = options.timeoutMs ?? 12e4;
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ctl.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort);
  let res;
  try {
    res = await fetch(`${apiBase}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    throw err;
  }
  if (!res.ok) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
    }
    const err = parsed?.error ?? {};
    throw new AxonBackendError({
      status: res.status,
      code: err.code ?? `http_${res.status}`,
      type: err.type ?? "server_error",
      message: err.message ?? `HTTP ${res.status}`,
      provider: err.provider,
      raw: parsed
    });
  }
  if (!res.body) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    throw new Error("Backend returned no response body.");
  }
  const decoder = new TextDecoder("utf-8");
  const reader = res.body.getReader();
  let buffer = "";
  let lastChunk = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const eventBlock = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = eventBlock.split("\n").map((l) => l.trimStart()).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const payloadText = dataLines.join("\n");
        if (payloadText === "[DONE]") {
          if (lastChunk) yield { type: "done", final: lastChunk };
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(payloadText);
        } catch {
          continue;
        }
        lastChunk = parsed;
        yield { type: "chunk", raw: parsed };
        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          yield { type: "delta", text: delta };
        }
      }
    }
    if (lastChunk) yield { type: "done", final: lastChunk };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
    }
  }
}

// src/commands/chat.ts
var STDIN_INITIAL_QUIET_MS = 150;
var STDIN_POST_DATA_QUIET_MS = 1e3;
async function readStdin() {
  if (process.stdin.isTTY === true) return "";
  return new Promise((resolve3, reject) => {
    let data = "";
    let timer = null;
    let sawData = false;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
    };
    const armQuiet = (ms) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cleanup();
        resolve3(data);
      }, ms);
    };
    armQuiet(STDIN_INITIAL_QUIET_MS);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      sawData = true;
      armQuiet(STDIN_POST_DATA_QUIET_MS);
    });
    process.stdin.on("end", () => {
      cleanup();
      resolve3(data);
    });
    process.stdin.on("error", (err) => {
      cleanup();
      if (sawData) resolve3(data);
      else reject(err);
    });
  });
}
function buildPrompt(arg, stdin) {
  const a = arg.trim();
  const s = stdin.trim();
  if (a && s) {
    return `${a}

---
${s}
---`;
  }
  return a || s;
}
function formatMetaLine(final) {
  const meta = final.meta ?? {};
  const model = typeof final.model === "string" && final.model.length > 0 ? final.model : meta.model;
  if (!model) return null;
  const reasons = [];
  const fastPath = meta.fastPath;
  const routing = meta.routing;
  const intent = meta.intent;
  if (fastPath) reasons.push(`fast-path ${fastPath}`);
  if (routing) reasons.push(routing);
  else if (intent) reasons.push(`intent ${intent}`);
  const cost = typeof meta.cost === "number" ? meta.cost : void 0;
  const creditsSaved = typeof meta.creditsSaved === "number" ? meta.creditsSaved : void 0;
  const tail = [];
  if (typeof cost === "number") tail.push(`$${cost.toFixed(4)} spent`);
  if (typeof creditsSaved === "number") tail.push(`$${creditsSaved.toFixed(4)} saved`);
  const head = reasons.length > 0 ? `routed ${model} via ${reasons.join(", ")}` : `routed ${model}`;
  return tail.length > 0 ? `${head} (${tail.join(", ")})` : head;
}
async function runChat(promptArg, opts) {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    console.error(chalk6.yellow("Not logged in.") + " Run " + chalk6.bold("axon login") + " first.");
    process.exitCode = 1;
    return;
  }
  const stdin = await readStdin();
  const prompt2 = buildPrompt(promptArg, stdin);
  if (!prompt2) {
    console.error(chalk6.red("\u2717 No prompt. Pass one as an argument or pipe via stdin."));
    process.exitCode = 1;
    return;
  }
  const body = {
    model: opts.model ?? cfg.defaultModel ?? "auto",
    messages: [{ role: "user", content: prompt2 }],
    stream: true,
    mode: opts.mode ?? "chat"
  };
  const ctl = new AbortController();
  const onSignal = () => {
    ctl.abort(new Error("user cancelled"));
  };
  process.on("SIGINT", onSignal);
  let final = null;
  const collected = [];
  try {
    const stream = streamChat(body, {
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      byok: {
        openai: opts.byokOpenaiKey,
        anthropic: opts.byokAnthropicKey,
        google: opts.byokGoogleKey
      },
      signal: ctl.signal
    });
    for await (const ev of stream) {
      if (ev.type === "delta") {
        if (opts.json) {
          collected.push(ev.text);
        } else {
          process.stdout.write(ev.text);
        }
      } else if (ev.type === "done") {
        final = ev.final;
      }
    }
  } catch (err) {
    process.off("SIGINT", onSignal);
    if (err instanceof AxonBackendError) {
      if (err.status === 401) {
        console.error("\n" + chalk6.red("\u2717 Invalid or revoked key.") + " Run " + chalk6.bold("axon login") + " to refresh.");
      } else {
        console.error("\n" + chalk6.red(`\u2717 ${err.message}`) + chalk6.dim(`  (${err.code})`));
      }
    } else {
      console.error("\n" + chalk6.red(`\u2717 ${err.message ?? err}`));
    }
    process.exitCode = 1;
    return;
  }
  process.off("SIGINT", onSignal);
  if (opts.json) {
    const text = collected.join("");
    const out = {
      content: text,
      model: final?.model,
      usage: final?.usage,
      meta: final?.meta,
      code_edit: final?.code_edit,
      extras: { budget: final?.budget, extra_files: final?.extra_files }
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  process.stdout.write("\n");
  if (opts.meta !== false && final) {
    const line = formatMetaLine(final);
    if (line) console.log(chalk6.dim(`> ${line}`));
  }
}
function registerChat(program2) {
  program2.command("chat [prompt...]").description("One-shot completion. Pipe context via stdin.").option("-m, --model <model>", "Specific model id (default: auto \u2014 let AXON route).").option("-M, --mode <mode>", "Session mode: auto | coding | chat", "chat").option("--byok-openai-key <key>", "Forward an OpenAI key (header x-openai-key).").option("--byok-anthropic-key <key>", "Forward an Anthropic key (header x-anthropic-key).").option("--byok-google-key <key>", "Forward a Google key (header x-google-key).").option("--json", "Emit a single JSON blob instead of streaming text.").option("--no-meta", "Suppress the routing trace line after the response.").action(async (promptParts, opts) => {
    await runChat(promptParts.join(" "), opts);
  });
}
async function runChatDirect(promptArg, opts) {
  return runChat(promptArg, opts);
}

// src/commands/repl.ts
import chalk9 from "chalk";

// src/repl.ts
import { createInterface } from "readline";
import { randomUUID } from "crypto";
import chalk8 from "chalk";

// src/context.ts
import { promises as fs } from "fs";
import { basename, isAbsolute, relative, resolve } from "path";
var MAX_CONTEXT_CHARS = 32e3;
function totalChars(files) {
  let n = 0;
  for (const f of files) n += f.content.length;
  return n;
}
var AttachedFiles = class {
  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
  }
  workspaceRoot;
  files = /* @__PURE__ */ new Map();
  list() {
    return [...this.files.values()];
  }
  size() {
    return this.files.size;
  }
  clear() {
    this.files.clear();
  }
  has(absPath) {
    return this.files.has(absPath);
  }
  /**
   * Read the file from disk and add it to the set. Returns the AttachedFile.
   * Throws on FS error or when adding the file would exceed MAX_CONTEXT_CHARS.
   */
  async add(rawPath) {
    const abs = isAbsolute(rawPath) ? rawPath : resolve(this.workspaceRoot, rawPath);
    if (this.files.has(abs)) return this.files.get(abs);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      throw new Error(`not a regular file: ${abs}`);
    }
    const content = await fs.readFile(abs, "utf-8");
    const currentTotal = totalChars(this.files.values());
    if (currentTotal + content.length > MAX_CONTEXT_CHARS) {
      throw new Error(
        `attaching ${basename(abs)} would exceed the ${MAX_CONTEXT_CHARS / 1e3}k context cap (${currentTotal} chars already attached + ${content.length} new). Use /clear or attach a smaller file.`
      );
    }
    const file = {
      path: abs,
      relPath: relative(this.workspaceRoot, abs) || basename(abs),
      content,
      bytes: Buffer.byteLength(content, "utf-8"),
      language: detectLanguage(abs)
    };
    this.files.set(abs, file);
    return file;
  }
  remove(absPath) {
    return this.files.delete(absPath);
  }
  /**
   * Build the BackendContext sent on the next /v1/chat/completions request.
   *
   * Strategy: the first attached file becomes `activeFile`. The rest are
   * concatenated as fenced markdown into the user prompt by the REPL (see
   * `buildPromptWithAttachments`). The backend's agent pipeline already
   * keys on activeFile for routing, so the first file should be the one
   * the user is asking about.
   */
  toBackendContext() {
    if (this.files.size === 0) return { workspacePath: this.workspaceRoot };
    const list = this.list();
    const first = list[0];
    const rest = list.slice(1);
    return {
      workspacePath: this.workspaceRoot,
      activeFile: {
        path: first.path,
        content: first.content,
        language: first.language
      },
      recentFiles: rest.length > 0 ? rest.map((f) => f.path) : void 0
    };
  }
};
function buildPromptWithAttachments(promptText, attached) {
  const list = attached.list();
  if (list.length <= 1) return promptText;
  const rest = list.slice(1);
  const blocks = [promptText.trim()];
  blocks.push("");
  blocks.push("---");
  for (const f of rest) {
    blocks.push(`### ${f.relPath}`);
    blocks.push("```" + f.language);
    blocks.push(f.content);
    blocks.push("```");
  }
  blocks.push("---");
  return blocks.join("\n");
}
function detectLanguage(path) {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const map = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    kt: "kotlin",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ps1: "powershell",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    graphql: "graphql",
    proto: "protobuf"
  };
  return map[ext] ?? "plaintext";
}

// src/mode.ts
var DEFAULT_SESSION_MODE = "auto";
function isSessionMode(s) {
  return s === "auto" || s === "coding" || s === "chat";
}

// src/pending.ts
var PendingEditState = class {
  pending = null;
  lastApplied = null;
  lastAppliedRequestId = null;
  setPending(p) {
    this.pending = p;
  }
  getPending() {
    return this.pending;
  }
  clearPending() {
    this.pending = null;
  }
  setLastApplied(applied, requestId) {
    this.lastApplied = applied;
    this.lastAppliedRequestId = requestId;
  }
  getLastApplied() {
    if (!this.lastApplied || !this.lastAppliedRequestId) return null;
    return { applied: this.lastApplied, requestId: this.lastAppliedRequestId };
  }
  clearLastApplied() {
    this.lastApplied = null;
    this.lastAppliedRequestId = null;
  }
};

// src/diff.ts
import { existsSync as existsSync2, promises as fs2 } from "fs";
import { dirname, isAbsolute as isAbsolute2, resolve as resolve2 } from "path";
var PLACEHOLDER_PATTERNS = ["...", "// rest of code", "/* rest of code */"];
function validateSearchReplace(edit) {
  if (edit.search.includes("...")) {
    return { valid: false, reason: 'search block contains "..." placeholder \u2014 incomplete patch rejected' };
  }
  if (edit.replace.includes("...")) {
    return { valid: false, reason: 'replace block contains "..." placeholder \u2014 incomplete patch rejected' };
  }
  return { valid: true };
}
function validateAppliedContent(original, updated) {
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (updated.includes(pat) && !original.includes(pat)) {
      return { valid: false, reason: `applied content contains placeholder "${pat}" \u2014 return complete valid patch` };
    }
  }
  return { valid: true };
}
function parseCodeEdit(response) {
  if (!response || typeof response !== "object") return null;
  const r = response;
  if (r.type !== "code_edit") return null;
  if (typeof r.search === "string" && typeof r.replace === "string" && typeof r.filePath === "string") {
    return { filePath: r.filePath, search: r.search, replace: r.replace };
  }
  if (typeof r.newContent === "string" && typeof r.filePath === "string") {
    return { filePath: r.filePath, newContent: r.newContent };
  }
  return null;
}
function resolveFilePath(filePath, workspaceRoot) {
  const cleaned = filePath.replace(/^file:\/\//i, "").trim();
  const root = workspaceRoot ?? process.cwd();
  const abs = isAbsolute2(cleaned) ? cleaned : resolve2(root, cleaned);
  if (/file:[/\\]/i.test(abs)) {
    throw new Error(`[diff] resolved path "${abs}" contains a nested file:// scheme \u2014 refusing to write.`);
  }
  return abs;
}
function computeUpdatedContent(originalSource, edit) {
  const normSource = originalSource.replace(/\r\n/g, "\n");
  const normSearch = edit.search.replace(/\r\n/g, "\n");
  const replace = edit.replace.replace(/\r\n/g, "\n");
  const idx = normSource.indexOf(normSearch);
  if (idx !== -1) {
    return normSource.slice(0, idx) + replace + normSource.slice(idx + normSearch.length);
  }
  const normMatch = findNormalizedMatch(normSource, normSearch);
  if (!normMatch) {
    throw new Error(
      `[diff] search block did not match (exact + whitespace-normalised both failed). Search head:
${edit.search.slice(0, 200)}${edit.search.length > 200 ? "\u2026" : ""}`
    );
  }
  return normSource.slice(0, normMatch.startChar) + replace + normSource.slice(normMatch.endChar);
}
function findNormalizedMatch(source, search) {
  const srcLines = source.split("\n");
  const srcNonEmpty = srcLines.map((l, i) => ({ trimmed: l.trim(), origIdx: i })).filter(({ trimmed }) => trimmed.length > 0);
  const searchTrimmed = search.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (searchTrimmed.length === 0 || srcNonEmpty.length < searchTrimmed.length) return null;
  for (let i = 0; i <= srcNonEmpty.length - searchTrimmed.length; i++) {
    let matched = true;
    for (let j = 0; j < searchTrimmed.length; j++) {
      if (srcNonEmpty[i + j].trimmed !== searchTrimmed[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const firstLineIdx = srcNonEmpty[i].origIdx;
    const lastLineIdx = srcNonEmpty[i + searchTrimmed.length - 1].origIdx;
    let startChar = 0;
    for (let k = 0; k < firstLineIdx; k++) startChar += srcLines[k].length + 1;
    let endChar = startChar;
    for (let k = firstLineIdx; k <= lastLineIdx; k++) endChar += srcLines[k].length + 1;
    return { startChar, endChar: Math.min(endChar, source.length) };
  }
  return null;
}
async function applyCodeEdit(payload, workspaceRoot) {
  if (!payload.filePath || payload.filePath.trim() === "") {
    throw new Error("[diff] cannot apply edit: filePath is missing from the backend response.");
  }
  if ("newContent" in payload) {
    if (!payload.explicit) {
      throw new Error("[diff] full-file overwrite blocked \u2014 must be explicitly requested.");
    }
    return writeFullFile(resolveFilePath(payload.filePath, workspaceRoot), payload.newContent);
  }
  const pre = validateSearchReplace(payload);
  if (!pre.valid) throw new Error(`[diff] ${pre.reason}`);
  const abs = resolveFilePath(payload.filePath, workspaceRoot);
  const exists = existsSync2(abs);
  if (!exists) {
    throw new Error(`[diff] target file does not exist: ${abs}`);
  }
  const source = await fs2.readFile(abs, "utf-8");
  const updated = computeUpdatedContent(source, payload);
  const post = validateAppliedContent(source, updated);
  if (!post.valid) throw new Error(`[diff] ${post.reason}`);
  await fs2.writeFile(abs, updated, "utf-8");
  return { filePath: abs, originalContent: source, updatedContent: updated, wasNewFile: false };
}
async function writeFullFile(abs, content) {
  const wasNewFile = !existsSync2(abs);
  let originalContent = "";
  if (!wasNewFile) {
    originalContent = await fs2.readFile(abs, "utf-8");
  } else {
    await fs2.mkdir(dirname(abs), { recursive: true });
  }
  await fs2.writeFile(abs, content, "utf-8");
  return { filePath: abs, originalContent, updatedContent: content, wasNewFile };
}
async function revertAppliedEdit(applied) {
  if (applied.wasNewFile) {
    try {
      await fs2.unlink(applied.filePath);
    } catch {
    }
    return;
  }
  await fs2.writeFile(applied.filePath, applied.originalContent, "utf-8");
}

// src/render.ts
import chalk7 from "chalk";
import { structuredPatch } from "diff";
var CONTEXT_LINES = 3;
function renderUnifiedDiff(original, updated, header) {
  const patch = structuredPatch(
    header?.filePath ?? "a",
    header?.filePath ?? "b",
    original,
    updated,
    "",
    "",
    { context: CONTEXT_LINES }
  );
  const lines = [];
  if (header?.filePath || header?.subject) {
    const title = header?.filePath ?? header?.subject ?? "";
    lines.push(chalk7.bold.cyan(`\u2500\u2500\u2500\u2500 ${title} \u2500\u2500\u2500\u2500`));
  }
  for (const hunk of patch.hunks) {
    lines.push(formatHunkHeader(hunk));
    for (const ln of hunk.lines) {
      const ch = ln[0];
      const body = ln.slice(1);
      if (ch === "+") lines.push(chalk7.green(`+ ${body}`));
      else if (ch === "-") lines.push(chalk7.red(`- ${body}`));
      else if (ch === "\\") lines.push(chalk7.dim(`  ${body}`));
      else lines.push(chalk7.dim(`  ${body}`));
    }
  }
  if (lines.length === 0) lines.push(chalk7.dim("(no changes)"));
  return lines.join("\n");
}
function formatHunkHeader(hunk) {
  return chalk7.cyan(
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  );
}
function renderSearchReplace(filePath, search, replace) {
  const lines = [];
  lines.push(chalk7.bold.cyan(`\u2500\u2500\u2500\u2500 ${filePath} \u2500\u2500\u2500\u2500`));
  for (const l of search.split("\n")) lines.push(chalk7.red(`- ${l}`));
  for (const l of replace.split("\n")) lines.push(chalk7.green(`+ ${l}`));
  return lines.join("\n");
}

// src/telemetry.ts
async function postEditorEvent(input) {
  const cfg = readConfig();
  if (cfg.telemetry === false) return false;
  if (!cfg.apiKey) return false;
  const wire = {
    ...input,
    // Backend overwrites tenantId from the bearer-auth context, but the
    // validation gate insists on a string field — send the configured one.
    tenantId: cfg.tenantId ?? "cli",
    timestamp: Date.now()
  };
  try {
    await postJson("/v1/editor/events", wire, { timeoutMs: 1e4 });
    return true;
  } catch (err) {
    if (err instanceof AxonBackendError) {
      if (err.status === 401) {
        console.warn(`[telemetry] ${err.code}: ${err.message} \u2014 run \`axon login\` to refresh.`);
      }
    }
    return false;
  }
}

// src/repl.ts
function banner(state) {
  console.log("");
  console.log("  " + chalk8.bold("AXON") + chalk8.dim("  \xB7  /help for commands, /exit to leave"));
  console.log("  " + chalk8.dim(`mode: ${state.mode}  \xB7  cwd: ${state.attached.workspaceRoot}`));
  console.log("");
}
function helpText() {
  return [
    "",
    chalk8.bold("commands"),
    `  ${chalk8.cyan("/file <path>")}        attach a file (counts toward 32k context cap)`,
    `  ${chalk8.cyan("/files <p1> <p2>")}    attach multiple files`,
    `  ${chalk8.cyan("/clear")}              detach all files + drop pending edit`,
    `  ${chalk8.cyan("/status")}             attached files, mode, pending edit`,
    `  ${chalk8.cyan("/mode <auto|coding|chat>")}  toggle session mode`,
    `  ${chalk8.cyan("/diff")}               re-show the current pending diff`,
    `  ${chalk8.cyan("/apply")} or ${chalk8.cyan("a")}        apply the pending edit (fires edit_accepted)`,
    `  ${chalk8.cyan("/reject")} or ${chalk8.cyan("r")}       reject the pending edit (fires edit_rejected)`,
    `  ${chalk8.cyan("/undo")}               revert the last applied edit`,
    `  ${chalk8.cyan("/help")}               this list`,
    `  ${chalk8.cyan("/exit")} or ${chalk8.cyan("Ctrl-D")}   leave the REPL`,
    ""
  ].join("\n");
}
function formatMetaLine2(final) {
  const meta = final.meta ?? {};
  const model = typeof final.model === "string" && final.model || meta.model;
  if (!model) return null;
  const reasons = [];
  if (meta.fastPath) reasons.push(`fast-path ${meta.fastPath}`);
  if (meta.routing) reasons.push(meta.routing);
  else if (meta.intent) reasons.push(`intent ${meta.intent}`);
  const tail = [];
  if (typeof meta.cost === "number") tail.push(`$${meta.cost.toFixed(4)} spent`);
  if (typeof meta.creditsSaved === "number") tail.push(`$${meta.creditsSaved.toFixed(4)} saved`);
  const head = reasons.length > 0 ? `routed ${model} via ${reasons.join(", ")}` : `routed ${model}`;
  return tail.length > 0 ? `${head} (${tail.join(", ")})` : head;
}
function getRequestIdFromFinal(final) {
  const meta = final.meta ?? {};
  const id = meta.requestId;
  if (typeof id === "string" && id.length > 0) return id;
  return randomUUID();
}
async function runTurn(state, userPrompt) {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    console.log(chalk8.yellow("(not logged in \u2014 run `axon login`)"));
    return;
  }
  const prompt2 = buildPromptWithAttachments(userPrompt, state.attached);
  const ctx = state.attached.toBackendContext();
  const body = {
    model: cfg.defaultModel ?? "auto",
    messages: [{ role: "user", content: prompt2 }],
    stream: true,
    mode: state.mode
  };
  if (ctx) body.context = ctx;
  const ctl = new AbortController();
  const onSig = () => ctl.abort(new Error("user cancelled"));
  process.on("SIGINT", onSig);
  let final = null;
  try {
    for await (const ev of streamChat(body, { apiBase: cfg.apiBase, apiKey: cfg.apiKey, signal: ctl.signal })) {
      if (ev.type === "delta") process.stdout.write(ev.text);
      else if (ev.type === "done") final = ev.final;
    }
  } catch (err) {
    process.off("SIGINT", onSig);
    if (err instanceof AxonBackendError) {
      if (err.status === 401) {
        console.error("\n" + chalk8.red("\u2717 Invalid or revoked key.") + " Run " + chalk8.bold("axon login") + " to refresh.");
      } else {
        console.error("\n" + chalk8.red(`\u2717 ${err.message}`) + chalk8.dim(`  (${err.code})`));
      }
    } else {
      console.error("\n" + chalk8.red(`\u2717 ${err.message ?? err}`));
    }
    return;
  }
  process.off("SIGINT", onSig);
  process.stdout.write("\n");
  if (final) {
    const line = formatMetaLine2(final);
    if (line) console.log(chalk8.dim(`> ${line}`));
  }
  if (final?.code_edit) {
    const payload = parseCodeEdit({ type: "code_edit", ...final.code_edit });
    if (payload) {
      await handleProposedEdit(state, payload, getRequestIdFromFinal(final));
    }
  }
}
async function handleProposedEdit(state, payload, requestId) {
  if (!("newContent" in payload)) {
    const v = validateSearchReplace(payload);
    if (!v.valid) {
      console.log(chalk8.yellow(`
(model returned an invalid edit: ${v.reason})`));
      return;
    }
  }
  state.pending.setPending({ payload, requestId, proposedAt: Date.now() });
  await postEditorEvent({ event: "edit_proposed", requestId, filePath: payload.filePath });
  console.log("");
  if ("newContent" in payload) {
    console.log(chalk8.bold.cyan(`\u2500\u2500\u2500\u2500 ${payload.filePath} (full-file write) \u2500\u2500\u2500\u2500`));
    console.log(chalk8.dim(`(${payload.newContent.length} chars)`));
  } else {
    console.log(renderSearchReplace(payload.filePath, payload.search, payload.replace));
  }
  console.log(chalk8.dim("\n[a]pply / [r]eject / [e]dit  \u2014 or send another prompt to refine"));
}
async function cmdApply(state) {
  const p = state.pending.getPending();
  if (!p) {
    console.log(chalk8.dim("(nothing pending)"));
    return;
  }
  try {
    const applied = await applyCodeEdit(
      "newContent" in p.payload ? { ...p.payload, explicit: true } : p.payload,
      state.attached.workspaceRoot
    );
    state.pending.setLastApplied(applied, p.requestId);
    state.pending.clearPending();
    await postEditorEvent({ event: "edit_applied", requestId: p.requestId, filePath: applied.filePath });
    await postEditorEvent({ event: "edit_accepted", requestId: p.requestId, filePath: applied.filePath });
    console.log(chalk8.green(`\u2713 applied ${applied.filePath}`) + chalk8.dim(applied.wasNewFile ? "  (new file)" : ""));
  } catch (err) {
    console.error(chalk8.red(`\u2717 ${err.message}`));
  }
}
async function cmdReject(state) {
  const p = state.pending.getPending();
  if (!p) {
    console.log(chalk8.dim("(nothing pending)"));
    return;
  }
  state.pending.clearPending();
  await postEditorEvent({ event: "edit_rejected", requestId: p.requestId, filePath: p.payload.filePath, method: "command" });
  console.log(chalk8.yellow("\u2717 rejected") + chalk8.dim(" \u2014 fed back to routing memory"));
}
async function cmdUndo(state) {
  const la = state.pending.getLastApplied();
  if (!la) {
    console.log(chalk8.dim("(nothing to undo)"));
    return;
  }
  try {
    await revertAppliedEdit(la.applied);
    state.pending.clearLastApplied();
    await postEditorEvent({ event: "edit_rejected", requestId: la.requestId, filePath: la.applied.filePath, method: "undo" });
    console.log(chalk8.yellow(`\u21B6 reverted ${la.applied.filePath}`));
  } catch (err) {
    console.error(chalk8.red(`\u2717 ${err.message}`));
  }
}
function cmdDiff(state) {
  const p = state.pending.getPending();
  if (!p) {
    console.log(chalk8.dim("(nothing pending)"));
    return;
  }
  if ("newContent" in p.payload) {
    console.log(chalk8.bold.cyan(`\u2500\u2500\u2500\u2500 ${p.payload.filePath} (full-file write) \u2500\u2500\u2500\u2500`));
    console.log(chalk8.dim(`(${p.payload.newContent.length} chars)`));
  } else {
    try {
      const onDisk = state.attached.list().find((a) => a.path.endsWith(p.payload.filePath))?.content;
      if (onDisk) {
        console.log(renderUnifiedDiff(onDisk, onDisk.replace(p.payload.search, p.payload.replace), { filePath: p.payload.filePath }));
        return;
      }
    } catch {
    }
    console.log(renderSearchReplace(p.payload.filePath, p.payload.search, p.payload.replace));
  }
}
function cmdStatus(state) {
  console.log("");
  console.log(`  ${chalk8.dim("mode:")}      ${state.mode}`);
  console.log(`  ${chalk8.dim("cwd:")}       ${state.attached.workspaceRoot}`);
  console.log(`  ${chalk8.dim("attached:")}  ${state.attached.size()} file${state.attached.size() === 1 ? "" : "s"}`);
  for (const f of state.attached.list()) {
    console.log(`    \xB7 ${f.relPath} ${chalk8.dim(`(${f.bytes}B)`)}`);
  }
  const p = state.pending.getPending();
  if (p) {
    const kind = "newContent" in p.payload ? "full-file" : "search/replace";
    console.log(`  ${chalk8.dim("pending:")}   ${p.payload.filePath} ${chalk8.dim(`(${kind})`)}`);
  } else {
    console.log(`  ${chalk8.dim("pending:")}   ${chalk8.dim("(none)")}`);
  }
  const la = state.pending.getLastApplied();
  if (la) console.log(`  ${chalk8.dim("undoable:")}  ${la.applied.filePath}`);
  console.log("");
}
async function dispatch(state, line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { exit: false };
  const pendingExists = state.pending.getPending() !== null;
  if (pendingExists && (trimmed === "a" || trimmed === "A")) {
    await cmdApply(state);
    return { exit: false };
  }
  if (pendingExists && (trimmed === "r" || trimmed === "R")) {
    await cmdReject(state);
    return { exit: false };
  }
  if (pendingExists && (trimmed === "e" || trimmed === "E")) {
    console.log(chalk8.dim("(pending kept \u2014 send a refining prompt to update it)"));
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
      console.log(chalk8.dim("(cleared attachments + pending)"));
      return { exit: false };
    case "mode": {
      const m = args.trim();
      if (!m) {
        console.log(`  current mode: ${state.mode}`);
        return { exit: false };
      }
      if (!isSessionMode(m)) {
        console.log(chalk8.red(`\u2717 unknown mode "${m}" \u2014 expected auto | coding | chat`));
        return { exit: false };
      }
      state.mode = m;
      console.log(chalk8.dim(`(mode \u2192 ${m})`));
      return { exit: false };
    }
    case "file": {
      if (!args) {
        console.log(chalk8.red("\u2717 /file <path>"));
        return { exit: false };
      }
      try {
        const f = await state.attached.add(args);
        console.log(chalk8.dim(`\u2713 attached ${f.relPath} (${f.bytes}B)`));
      } catch (err) {
        console.log(chalk8.red(`\u2717 ${err.message}`));
      }
      return { exit: false };
    }
    case "files": {
      const paths = rest.filter(Boolean);
      if (paths.length === 0) {
        console.log(chalk8.red("\u2717 /files <path1> <path2> \u2026"));
        return { exit: false };
      }
      for (const p of paths) {
        try {
          const f = await state.attached.add(p);
          console.log(chalk8.dim(`\u2713 ${f.relPath} (${f.bytes}B)`));
        } catch (err) {
          console.log(chalk8.red(`\u2717 ${p}: ${err.message}`));
        }
      }
      return { exit: false };
    }
    case "diff":
      cmdDiff(state);
      return { exit: false };
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
      console.log(chalk8.red(`\u2717 unknown command "/${cmd}" \u2014 try /help`));
      return { exit: false };
  }
}
function prompt(rl) {
  rl.setPrompt(chalk8.bold.green("\u203A "));
  rl.prompt();
}
async function runRepl() {
  const state = {
    attached: new AttachedFiles(process.cwd()),
    mode: DEFAULT_SESSION_MODE,
    pending: new PendingEditState()
  };
  banner(state);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    historySize: 200
  });
  prompt(rl);
  for await (const rawLine of rl) {
    try {
      const { exit } = await dispatch(state, rawLine);
      if (exit) break;
    } catch (err) {
      console.error(chalk8.red(`\u2717 ${err.message ?? err}`));
    }
    prompt(rl);
  }
  rl.close();
  console.log("");
}

// src/commands/repl.ts
function registerRepl(program2) {
  program2.command("repl").description("Start the interactive REPL (also the bare `axon` action when logged in).").action(async () => {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      console.error(chalk9.yellow("Not logged in.") + " Run " + chalk9.bold("axon login") + " first.");
      process.exitCode = 1;
      return;
    }
    await runRepl();
  });
}

// src/onboarding.ts
import chalk10 from "chalk";
import prompts from "prompts";
function banner2() {
  console.log("");
  console.log("  " + chalk10.bold("AXON") + chalk10.dim("  \xB7  the operating layer for AI agents"));
  console.log("  " + chalk10.dim("run \xB7 route \xB7 remember \xB7 spend"));
  console.log("");
}
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.AXON_NO_PROMPT !== "1";
}
function shouldRunFirstRun() {
  if (!isInteractive()) return false;
  if (process.env.CI === "true") return false;
  const cfg = readConfig();
  return !cfg.apiKey;
}
async function runFirstRun() {
  banner2();
  console.log("  " + chalk10.dim("Looks like this is your first AXON session."));
  console.log("  " + chalk10.dim("Let's get you authenticated \u2014 pick one:"));
  console.log("");
  const response = await prompts({
    type: "select",
    name: "method",
    message: "How would you like to log in?",
    choices: [
      {
        title: "Sign in via browser",
        description: "Opens axon.nexalyte.tech/cli and waits for approval. Recommended.",
        value: "browser"
      },
      {
        title: "Paste an existing AXON API key",
        description: "Headless \u2014 for CI, SSH, or if you already have a key in hand.",
        value: "paste"
      },
      {
        title: "I don't have a key yet",
        description: "Opens the waitlist. Come back and run `axon login` once you're in.",
        value: "waitlist"
      }
    ],
    initial: 0
  }, {
    onCancel: () => {
    }
  });
  const cfg = readConfig();
  switch (response.method) {
    case "browser":
      console.log("");
      await runDeviceCodeFlow(cfg.apiBase, { noBrowser: false });
      return;
    case "paste": {
      const keyResp = await prompts({
        type: "password",
        name: "key",
        message: "Paste your AXON API key (axon_live_\u2026 or axon_test_\u2026):",
        validate: (v) => v.trim().startsWith("axon_") ? true : "Must start with axon_"
      });
      if (!keyResp.key) {
        console.log(chalk10.dim("  (cancelled)"));
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
      console.log("  " + chalk10.cyan(url) + (opened ? chalk10.dim("  (opened for you)") : ""));
      console.log("  " + chalk10.dim("Claim a seat. Once approved you'll receive an AXON API key \u2014 paste it via `axon login --key`."));
      return;
    }
    default:
      console.log(chalk10.dim("  (no changes)"));
      return;
  }
}

// src/index.ts
var VERSION = "0.0.5";
var program = new Command();
program.name("axon").description("AXON \u2014 the terminal client for routing + execution-memory.").version(VERSION, "-v, --version", "Show CLI version.").showHelpAfterError(chalk11.dim("(run `axon --help` for command list)"));
registerLogin(program);
registerWhoami(program);
registerLogout(program);
registerStats(program);
registerConfig(program);
registerChat(program);
registerRepl(program);
async function main() {
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
  const knownCommands = program.commands.map((c) => c.name());
  const first = process.argv[2];
  const isFlag = first?.startsWith("-");
  if (first && !isFlag && !knownCommands.includes(first)) {
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
    console.error(chalk11.red(`\u2717 ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
);
