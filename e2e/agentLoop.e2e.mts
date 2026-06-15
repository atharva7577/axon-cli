/**
 * agentLoop.e2e.mts — REAL end-to-end edit tests (Suite 3 of the AXON campaign).
 *
 * Drives the actual CLI multi-turn tool loop (runAgentTurn) against the LIVE
 * backend, in throwaway temp repos, and asserts:
 *   1. the FILE ON DISK changed correctly (the edit actually applied), AND
 *   2. the edit turn routed to a CAPABLE model (Layer 1 live proof) — captured
 *      from the routing meta line the CLI prints (showMeta).
 * This is the exact protocol Continue/Cline/the CLI use.
 *
 *   AXON_KEY=axon_live_... npx tsx e2e/agentLoop.e2e.mts
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn, type ChatMessage } from "../src/agent.js";
import { PermissionStore } from "../src/permissions.js";

const KEY  = process.env.AXON_KEY;
const BASE = process.env.AXON_BASE ?? "https://api.axon.nexalyte.tech";
if (!KEY) { console.error("Set AXON_KEY"); process.exit(2); }

const SYS = "You are a coding agent working in the user's current directory. Use the read_file / edit_file / write_file tools to make changes directly on disk. Make the requested change, then briefly confirm.";

const ANSI = /\x1b\[[0-9;]*m/g;
// "cheap" tier = the small models that botch search/replace (the ones Layer 1 must avoid for edits).
const isCheap = (m: string) => /mini|nano|haiku|flash/i.test(m);

interface Scenario {
  name:   string;
  files:  Record<string, string>;
  prompt: string;
  check:  (dir: string) => { ok: boolean; detail: string };
  /** true → the edit turn must route to a capable (non-cheap) model. */
  expectCapable: boolean;
}

const scenarios: Scenario[] = [
  {
    name: "single-file edit",
    files: { "foo.py": "def add(a, b):\n    return a + b\n" },
    prompt: "In foo.py, change the add function so it returns a - b instead of a + b.",
    check: (d) => { const t = readFileSync(join(d, "foo.py"), "utf-8"); return { ok: t.includes("a - b") && !t.includes("a + b"), detail: JSON.stringify(t) }; },
    expectCapable: true,
  },
  {
    name: "create new file",
    files: {},
    prompt: "Create a file named hello.py that prints 'hello world' when run.",
    check: (d) => { const p = join(d, "hello.py"); if (!existsSync(p)) return { ok: false, detail: "hello.py not created" }; const t = readFileSync(p, "utf-8"); return { ok: /print\(/.test(t) && /hello world/i.test(t), detail: JSON.stringify(t.slice(0,120)) }; },
    expectCapable: true,
  },
  {
    name: "read-then-edit (multi-turn)",
    files: { "calc.js": "function mul(a, b) {\n  return a + b; // BUG: should multiply\n}\n" },
    prompt: "There's a bug in calc.js — read it, find the bug in mul, and fix it so it multiplies.",
    check: (d) => { const t = readFileSync(join(d, "calc.js"), "utf-8"); return { ok: t.includes("a * b"), detail: JSON.stringify(t) }; },
    expectCapable: true,
  },
  {
    name: "multi-file edit",
    files: { "a.py": "VERSION = 1\n", "b.py": "VERSION = 1\n" },
    prompt: "Bump VERSION from 1 to 2 in BOTH a.py and b.py.",
    check: (d) => { const a = readFileSync(join(d, "a.py"), "utf-8"); const b = readFileSync(join(d, "b.py"), "utf-8"); return { ok: a.includes("VERSION = 2") && b.includes("VERSION = 2"), detail: `a=${JSON.stringify(a)} b=${JSON.stringify(b)}` }; },
    expectCapable: true,
  },
  {
    name: "indentation-drift edit (whitespace-normalized apply)",
    files: { "deep.py": "class C:\n    def run(self):\n        value = compute_old()\n        return value\n" },
    prompt: "In deep.py, replace the call compute_old() with compute_new().",
    check: (d) => { const t = readFileSync(join(d, "deep.py"), "utf-8"); return { ok: t.includes("compute_new()") && !t.includes("compute_old()"), detail: JSON.stringify(t) }; },
    expectCapable: true,
  },
];

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "axon-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

async function run(): Promise<void> {
  const results: { name: string; ok: boolean; detail: string; model: string }[] = [];
  for (const s of scenarios) {
    const dir = makeRepo(s.files);
    const prevCwd = process.cwd();
    process.chdir(dir);
    const perms = new PermissionStore();
    (perms as any).request = async () => "allow"; // simulate the user clicking allow
    const messages: ChatMessage[] = [
      { role: "system", content: SYS },
      { role: "user", content: s.prompt },
    ];

    // Capture console.log to extract the routing meta line ("routed <model> via …").
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logged.push(args.map(String).join(" ")); };
    let model = "";
    try {
      await runAgentTurn(messages, perms, { apiBase: BASE, apiKey: KEY!, model: "auto", mode: "coding", showMeta: true, maxTurns: 12 });
      const metaLine = logged.map((l) => l.replace(ANSI, "")).reverse().find((l) => /routed\s+\S+/.test(l));
      model = metaLine?.match(/routed\s+(\S+)/)?.[1] ?? "";
      const r = s.check(dir);
      const diskOk = r.ok;
      const modelOk = !s.expectCapable || (model !== "" && !isCheap(model));
      results.push({
        name: s.name,
        ok: diskOk && modelOk,
        detail: (diskOk ? "" : `DISK: ${r.detail}  `) + (modelOk ? "" : `MODEL not capable: '${model || "<none captured>"}'`),
        model,
      });
    } catch (e) {
      results.push({ name: s.name, ok: false, detail: "THREW: " + ((e as Error).message ?? String(e)), model });
    } finally {
      console.log = origLog;
      process.chdir(prevCwd);
    }
  }

  console.log(`\n\n==================== SUITE 3 — LIVE ON-DISK EDITS ====================`);
  let pass = 0;
  for (const r of results) {
    console.log(`${r.ok ? "  ✓ PASS" : "  ✗ FAIL"}  ${r.name}   [model=${r.model || "?"}]`);
    if (!r.ok) console.log(`           ${r.detail.slice(0, 320)}`);
    if (r.ok) pass++;
  }
  console.log(`\nSuite 3: ${pass}/${results.length} edits applied on disk AND routed to a capable model`);
  process.exit(pass === results.length ? 0 : 1);
}

run().catch((e) => { console.error("harness crashed:", e); process.exit(1); });
