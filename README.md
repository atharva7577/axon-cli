# `@axon/cli`

The terminal-native client for **[AXON](https://axon.nexalyte.tech)** — the operating layer for AI agents.
Run, route, remember, spend — from your shell.

> **AXON is execution memory for coding agents.** It learns from what actually
> works inside your editor (accepted edits, test results, retries) and uses
> that to route future requests to the models that truly succeed, not just
> respond.

The CLI is the third surface on the AXON runtime (after the VS Code extension
and the MCP server) and shares the same per-tenant routing memory. Every
prompt you accept or reject from the terminal improves your routing for the
next request — on every surface.

---

## Install

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/atharva7577/axon-cli/main/install.sh | sh
```

### Windows (PowerShell)

```powershell
iwr -useb https://raw.githubusercontent.com/atharva7577/axon-cli/main/install.ps1 | iex
```

### Direct (any platform, requires Node ≥ 20)

```sh
npm i -g github:atharva7577/axon-cli --install-links
```

`--install-links` forces npm to copy the package instead of creating a junction
to its temp git-clone — without it the install looks like it succeeded but the
`axon` shim points to a deleted directory. (Once `@axon/cli` is published to
npm the canonical install becomes `npm i -g @axon/cli` with no extra flags.)

### Troubleshooting

**`axon: command not found` / `not recognized as the name of a cmdlet`**

The `axon` shim was installed into `npm prefix -g`, but that directory isn't
on your PATH yet. Two common reasons:

1. **You installed Node in this same shell session.** The official Node
   installer adds `%APPDATA%\npm` (Windows) / `~/.npm-global/bin` (Unix) to
   PATH, but only for shells started *after* the install. Open a new shell
   and try `axon --version` again.
2. **You're using nvm-windows / fnm / scoop.** Each manages global bins
   differently. Run `npm prefix -g` to see where the shim landed and add
   that directory (or its `bin/` subdir on Unix) to PATH.

You can also call the shim directly without changing PATH:

```sh
# Windows
& "$(npm prefix -g)\axon.cmd" --version

# Unix
"$(npm prefix -g)/bin/axon" --version
```

**PowerShell window closes during install**

Fixed in `install.ps1` since v0.0.4. The old script set
`$ErrorActionPreference = 'Stop'` and called `exit 1` on benign npm stderr,
which terminates the host shell when run via `iex`. Re-run the one-liner
with the current `main` script. If it still happens, open an issue with the
output of `$PSVersionTable.PSVersion` and what's on screen before the close.

---

## Quick start

```sh
axon                 # first run: a 3-option login wizard
axon login           # later: browser device-code flow
axon "explain what this file does" < src/foo.ts
axon                 # bare invocation lands you in an interactive REPL
```

A 30-second walkthrough:

```text
$ axon

  AXON  ·  the operating layer for AI agents
  run · route · remember · spend

  Looks like this is your first AXON session.
  Let's get you authenticated — pick one:

? How would you like to log in? › - Use arrow-keys. Return to submit.
❯   Sign in via browser
    Paste an existing AXON API key
    I don't have a key yet
```

Sign in via browser → AXON opens `https://axon.nexalyte.tech/cli`, you paste
the user-code shown in your terminal, and the CLI receives a fresh,
CLI-scoped API key for your tenant. Total time: ~20 seconds.

---

## Commands

| Command | What it does |
| --- | --- |
| `axon` | First-run wizard, then REPL (when authed) |
| `axon login [--key axon_…]` | Device-code flow, or headless paste |
| `axon whoami` | Tenant id + verify the key against the backend |
| `axon logout` | Wipe credentials from `~/.axon/config.json` |
| `axon stats` | Request count, cache rate, spend, savings |
| `axon chat "prompt"` | One-shot streamed completion |
| `axon "prompt"` | Shorthand — when the first arg isn't a known command, dispatches to `chat` |
| `cat foo \| axon chat "explain"` | Stdin becomes a fenced context block |
| `axon chat … --model <id>` | Bypass auto-routing |
| `axon chat … --byok-{openai,anthropic,google}-key <key>` | Forward `x-<provider>-key` |
| `axon chat … --json` | Single JSON blob (content, model, usage, meta, code_edit) |
| `axon chat … --no-meta` | Suppress the routing trace line |
| `axon chat … --agent` | Run the prompt through the agentic tool loop (built-in tools) instead of a plain stream |
| `axon repl` | Explicit entry to the REPL (also: bare `axon`) |
| `axon config get \| set \| list \| path` | Manage `~/.axon/config.json` |

### REPL slash commands

After `axon` opens the REPL:

| Command | What it does |
| --- | --- |
| `/file <path>` | Attach a file to the next request (counts toward the 32 k char cap) |
| `/files <p1> <p2> …` | Attach multiple files |
| `/clear` | Detach files, reset the conversation, and drop any pending edit |
| `/status` | Mode, cwd, attached files, pending edit, undoable, loaded memory |
| `/memory` or `/mem` | List the resolved `AXON.md` memory (re-reads from disk) |
| `/mode <auto\|coding\|chat>` | Toggle session mode |
| `/diff` | Re-show the pending diff |
| `/apply` or `a` | Apply the pending edit (fires `edit_accepted`) |
| `/reject` or `r` | Reject the pending edit (fires `edit_rejected`) |
| `/undo` | Revert the last applied edit |
| `/help` | This list |
| `/exit` or `Ctrl-D` | Leave the REPL |

When the backend returns a `code_edit`, the CLI renders the diff in
red/green and waits for your `[a/r/e]`. The accept/reject signal feeds
your tenant's routing memory — the same prompt next time may take a
different path because *you* taught the gateway which model gets it right.

### Built-in tools (agent mode)

Bare `axon` (the REPL) and `axon chat … --agent` run as a true agent: the model
can call eight built-in tools to do real work on your machine.

| Tool | Access | Gating |
| --- | --- | --- |
| `read_file`, `glob`, `grep`, `ls` | read-only | run silently |
| `bash` | run a shell command | prompts per call · *always allow* by `argv[0]` |
| `write_file`, `edit_file` | create / modify files | prompts per call · *always allow* by top-level dir |
| `web_fetch` | fetch a URL | prompts per call · *always allow* by hostname |

The loop runs up to 25 turns — streaming content, dispatching each tool call,
feeding the result back — until the model stops calling. On a non-TTY (CI,
pipes) every mutating tool auto-denies, so scripted runs stay safe.

---

## Configuration

`~/.axon/config.json` (mode `0o600` on POSIX, atomic writes). Override the
directory with `AXON_CONFIG_DIR` for sandboxed test runs.

| Key | Default | Notes |
| --- | --- | --- |
| `apiBase` | `https://api.axon.nexalyte.tech` | Backend gateway |
| `apiKey` | — | Set by `axon login` only |
| `defaultModel` | `auto` | Pass `auto` to let AXON route |
| `telemetry` | `true` | `editor_events` posting. Disable: `axon config set telemetry off` |
| `adminSecret` | — | For `axon admin …` (M5, coming soon) |
| `tenantId` | — | Display-only |

Read or modify with:

```sh
axon config list
axon config get apiBase
axon config set telemetry off
```

---

## Project memory (`AXON.md`)

The agent reads persistent project memory at session start and injects it into
its system prompt — the terminal analogue of a project instructions file.

Resolution order (root-most first; the most specific file wins on conflict):

1. `~/.axon/AXON.md` — global, user-wide
2. each directory from the git root down to your cwd — `AXON.md`, falling back
   to `CLAUDE.md` so a Claude Code project's memory file is honoured unchanged

All sources are concatenated under a 16 k-char budget; over budget, the global
and root-most files are dropped first. The REPL banner and `/status` show
what's loaded; `/memory` (`/mem`) re-reads from disk and lists the active
sources.

> Plain `axon chat "…"` (without `--agent`) stays user-only — no memory is
> injected — so a one-shot stream's routing and cost are unchanged.

---

## Telemetry

AXON learns from your accept/reject decisions to route your future requests.
Your prompts and edits stay on your tenant; routing improves only for you.

- Default: on
- Disable per-tenant: `axon config set telemetry off`
- Disable per-invocation: `--no-telemetry` flag (chat)
- The first-run wizard prints this disclosure before any event posts

---

## Roadmap

The CLI ships under the same milestone plan as the AXON backend:

| Milestone | Status |
| --- | --- |
| **M0** — auth + first backend call (`login` / `whoami` / `logout` / `stats` / `config`) | ✅ shipped (v0.0.1) |
| **M1** — `chat` + Unix pipe + BYOK + routing trace + first-run wizard | ✅ shipped (v0.0.2) |
| **M2** — REPL + colourised diff + closed-loop `editor_events` | ✅ shipped (v0.0.3) |
| **Agentic REPL** — eight built-in tools (read/glob/grep/ls/bash/write/edit/web_fetch) + multi-turn tool loop | ✅ shipped (v0.0.7) |
| **M3** — `AXON.md` memory hierarchy ✅ (v0.0.8) · `axon mcp serve` + Claude Code-compatible `SKILL.md` | 🚧 in progress |
| **M4** — `/route` reasoning, `axon compare`, `axon stats --by …` | planned |
| **M5** — `axon admin …`, `axon execute` project builder | planned |

---

## Requirements

- Node.js **≥ 20**
- A POSIX shell (macOS / Linux) or PowerShell 5+ (Windows)
- An AXON tenant API key — get one from the
  [waitlist](https://axon.nexalyte.tech)

---

## License

[MIT](./LICENSE) © Nexalyte Tech Solutions
