# Changelog

All notable changes to `@axon/cli` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## 0.0.8 — 2026-05-30 — M3 (1/3): AXON.md memory hierarchy

- Project-memory files are now resolved and injected into the agent system
  prompt at session start (REPL + `axon chat --agent`):
  - Global `~/.axon/AXON.md` (lowest precedence), then a cwd→up walk reading
    each ancestor dir's `AXON.md` (falling back to `CLAUDE.md` for Claude-Code
    compatibility), stopping at the git root. More-specific (cwd-local) files
    win on conflict.
  - Combined 16 k-char budget; over budget drops global/root-most first.
- REPL: banner + `/status` show resolved memory; new `/memory` (`/mem`)
  command re-reads from disk and lists the active sources.
- Plain (non-agent) `axon chat` is intentionally left user-only — no system
  injection — so the one-shot stream's routing/cost is unchanged.
- New: `src/axonmd.ts` (`resolveMemory` / `withMemory` / `memoryBannerLine`).

## 0.0.7 — 2026-05-29 — agentic REPL with built-in tools

- The REPL and `axon chat --agent` are now true agents: the model can call
  eight built-in tools to do real work on the machine —
  `read_file`, `glob`, `grep`, `ls` (read-only, run silently) and `bash`,
  `write_file`, `edit_file`, `web_fetch` (mutating, gated per call).
- Multi-turn tool loop (`src/agent.ts` `runAgentTurn`, max 25 turns):
  streams content, accumulates `tool_call_delta`s, dispatches each call,
  feeds results back as `role:"tool"` messages until the model stops calling.
- Session-scoped permission store (`src/permissions.ts`): "always allow" keyed
  by argv[0] (bash), top-level dir (write/edit), or hostname (web_fetch);
  non-TTY auto-denies so scripts stay safe.
- `src/sse.ts` extended with a `tool_call_delta` event; system prompt seeds
  the model with its tool affordances so it never refuses with "I can't read
  files."
- New: `src/tools/{schemas,registry,read,glob,grep,ls,bash,write,edit,webfetch}.ts`.

## 0.0.6 — 2026-05-29 — installer: in-script PATH patch

- `install.ps1` prepends the npm global-bin dir to `$env:PATH` for the current
  session **and** persists it to the User PATH via
  `[Environment]::SetEnvironmentVariable`, so `axon` works immediately without
  opening a new shell.

## 0.0.5 — 2026-05-29 — installer: resolve npm by absolute path

- Fixed `install.ps1` failing with "Unknown command: pm" when something in the
  user's PowerShell session shadowed `npm`: resolve `npm.cmd` via
  `Get-Command -CommandType Application` and invoke with splat-args
  (`& $npmCmd @installArgs`).

## 0.0.4 — 2026-05-29 — installer hardening

- `install.ps1` no longer calls `exit` (it was killing the host shell when run
  via `iex`); dropped `$ErrorActionPreference = 'Stop'`; ASCII-only output;
  added a post-install PATH check.

## 0.0.3 — 2026-05-28 — M2: REPL + closed-loop accept/reject

- Bare `axon` launches an interactive REPL when a key is on file
  (interactive TTY only; CI / non-TTY falls through to `--help`)
- Slash commands: `/file`, `/files`, `/clear`, `/status`, `/mode`,
  `/diff`, `/apply` (`a`), `/reject` (`r`), `/undo`, `/help`, `/exit`
- On backend `code_edit` responses: parses the payload, validates against
  `…` placeholders, renders a coloured unified diff inline, prompts for
  `[a]pply / [r]eject / [e]dit`
- Closed loop: each prompt fires `edit_proposed`, each `a` fires
  `edit_applied + edit_accepted`, each `r` fires `edit_rejected`
  (`method=command`), `/undo` fires `edit_rejected` (`method=undo`).
  Routing memory on the tenant updates from the next request onward.
- Ported (vscode-isms stripped) from the AXON VS Code extension:
  - `DiffApplier` → `src/diff.ts` (exact + whitespace-normalised search-
    and-replace, placeholder rejection, in-memory undo backup)
  - `EditorContext` → `src/context.ts` (`AttachedFiles`, 32 k char cap)
  - `CodingMode` → `src/mode.ts` (in-memory `SessionMode`)
- New: `src/render.ts` (jsdiff `structuredPatch` → ANSI hunks),
  `src/pending.ts` (single-slot `PendingEditState`), `src/telemetry.ts`
  (fire-and-forget `POST /v1/editor/events`, honours
  `cfg.telemetry === false`)
- Dep: `diff@^8.0.2` + `@types/diff@^8.0.0`

## 0.0.2 — 2026-05-28 — M1: chat + Unix pipe + first-run wizard

- `axon chat "prompt"` — one-shot SSE-streamed completion
- `axon "prompt"` — shorthand that dispatches to `chat` when the first
  argv token isn't a known subcommand
- `cat foo | axon chat "explain"` — stdin becomes a fenced context block
  appended to the arg-supplied prompt
- Flags: `--model`, `--mode auto|coding|chat`, `--json`, `--no-meta`,
  `--byok-openai-key`, `--byok-anthropic-key`, `--byok-google-key`
- Routing transparency: dim trailing line `> routed <model> via …
  ($X spent, $Y saved)` pulled from the SSE final chunk's `meta`
- First-run onboarding wizard: when `axon` is run with no args, no key
  on file, and stdin/stdout are TTYs — welcome banner + select prompt:
  - Sign in via browser (device-code flow)
  - Paste an existing AXON API key (password input)
  - I don't have a key yet (opens the waitlist)
- New: `src/sse.ts` (built-in fetch + event-stream parser, no extra
  deps), `src/commands/chat.ts`, `src/onboarding.ts`
- Hardening:
  - PowerShell quirk: stdin readers use a two-phase quiet-period race
    (150 ms initial, 1 s post-data) instead of `fstatSync` so bare
    invocations from PowerShell don't hang waiting for an EOF that
    never arrives
  - `main()` explicitly calls `process.exit(process.exitCode ?? 0)` so
    undici's fetch keep-alive pool can't hold the event loop open
- Dep: `prompts@^2.4.2` + `@types/prompts@^2.4.9`

## 0.0.1 — 2026-05-28 — M0: auth + first backend call

- Initial public surface
- Commands:
  - `axon login` — device-code flow against `POST /v1/auth/device`,
    polls `/poll`, writes `~/.axon/config.json` (mode `0o600` on POSIX)
  - `axon login --key axon_…` — headless paste, verified against
    `GET /v1/stats`
  - `axon whoami` — show tenant + key prefix, verify the key live
  - `axon logout` — wipe stored credentials
  - `axon stats` — request count, cache rate, spend, savings
  - `axon config get | set | list | path` — manage the config file
    (`apiKey` is intentionally read-only here — use `axon login`)
- Modules: `src/config.ts` (atomic writes, chmod 600), `src/http.ts`
  (Bearer-aware JSON wrapper, structured `AxonBackendError`),
  `src/browser.ts` (cross-platform URL opener)
- Default backend: `https://api.axon.nexalyte.tech` (override via
  `axon config set apiBase …`)
- Distribution: built with `tsup` to a single 18 KB ESM bundle,
  externals for `commander` / `chalk` / `ora` / `diff` / `prompts`
