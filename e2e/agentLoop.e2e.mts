/**
 * agentLoop.e2e.mts — REAL end-to-end edit tests.
 *
 * Drives the actual CLI multi-turn tool loop (runAgentTurn) against the LIVE
 * backend, in throwaway temp repos, and asserts the FILE ON DISK changed — the
 * test that was missing. This is the exact protocol Continue/Cline/the CLI use.
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

interface Scenario {
  name:   string;
  files:  Record<string, string>;
  prompt: string;
  check:  (dir: string) => { ok: boolean; detail: string };
}

const scenarios: Scenario[] = [
  {
    name: "single-file edit",
    files: { "foo.py": "def add(a, b):\n    return a + b\n" },
    prompt: "In foo.py, change the add function so it returns a - b instead of a + b.",
    check: (d) => { const t = readFileSync(join(d, "foo.py"), "utf-8"); return { ok: t.includes("a - b") && !t.includes("a + b"), detail: JSON.stringify(t) }; },
  },
  {
    name: "create new file",
    files: {},
    prompt: "Create a file named hello.py that prints 'hello world' when run.",
    check: (d) => { const p = join(d, "hello.py"); if (!existsSync(p)) return { ok: false, detail: "hello.py not created" }; const t = readFileSync(p, "utf-8"); return { ok: /print\(/.test(t) && /hello world/i.test(t), detail: JSON.stringify(t.slice(0,120)) }; },
  },
  {
    name: "read-then-edit (multi-turn)",
    files: { "calc.js": "function mul(a, b) {\n  return a + b; // BUG: should multiply\n}\n" },
    prompt: "There's a bug in calc.js — read it, find the bug in mul, and fix it so it multiplies.",
    check: (d) => { const t = readFileSync(join(d, "calc.js"), "utf-8"); return { ok: t.includes("a * b"), detail: JSON.stringify(t) }; },
  },
  {
    name: "multi-file edit",
    files: { "a.py": "VERSION = 1\n", "b.py": "VERSION = 1\n" },
    prompt: "Bump VERSION from 1 to 2 in BOTH a.py and b.py.",
    check: (d) => { const a = readFileSync(join(d, "a.py"), "utf-8"); const b = readFileSync(join(d, "b.py"), "utf-8"); return { ok: a.includes("VERSION = 2") && b.includes("VERSION = 2"), detail: `a=${JSON.stringify(a)} b=${JSON.stringify(b)}` }; },
  },
];

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "axon-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    writeFileSync(p, content);
  }
  return dir;
}

async function run(): Promise<void> {
  const results: { name: string; ok: boolean; detail: string }[] = [];
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
    console.log(`\n================ ${s.name} ================`);
    try {
      await runAgentTurn(messages, perms, { apiBase: BASE, apiKey: KEY!, model: "auto", mode: "coding", showMeta: false, maxTurns: 12 });
      const r = s.check(dir);
      results.push({ name: s.name, ok: r.ok, detail: r.detail });
    } catch (e) {
      results.push({ name: s.name, ok: false, detail: "THREW: " + ((e as Error).message ?? String(e)) });
    } finally {
      process.chdir(prevCwd);
    }
  }

  console.log(`\n\n==================== RESULTS ====================`);
  let pass = 0;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    if (!r.ok) console.log(`      ${r.detail.slice(0, 300)}`);
    if (r.ok) pass++;
  }
  console.log(`\nTOTAL: ${pass}/${results.length} edits actually applied on disk`);
  process.exit(pass === results.length ? 0 : 1);
}

run().catch((e) => { console.error("harness crashed:", e); process.exit(1); });
