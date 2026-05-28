# Changelog

All notable changes to `@axon/cli` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

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
