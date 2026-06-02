/**
 * discovery.ts — find Claude-Code-compatible `SKILL.md` skills on disk.
 *
 * A skill is a Markdown file with optional YAML-ish frontmatter (name +
 * description) followed by instructions the agent carries out. We scan three
 * directories, lowest precedence first (later dirs win on a name collision):
 *
 *   1. ~/.axon/skills/        global, user-wide
 *   2. ./.claude/skills/      project-local, Claude-Code compat
 *   3. ./.axon/skills/        project-local, AXON (highest precedence)
 *
 * Within a skills dir a skill is either `<name>.md` or `<name>/SKILL.md`; the
 * file/dir name is the canonical skill name (what `axon skill run <name>` takes).
 *
 * No YAML dependency — the frontmatter parser handles flat `key: value` lines
 * only (documented limit: no nested maps or multi-line values). Reads are
 * best-effort and hardened the same way as AXON.md memory: symlinks rejected,
 * 256 KB size cap, never throws.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.js";

/** Hard ceiling on a single skill file (OOM guard; mirrors axonmd.ts). */
const MAX_SKILL_BYTES = 256 * 1024;
/** Skill names must be a single safe path segment — blocks `../` traversal. */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export type SkillScope = "global" | "project";

export interface Skill {
  /** Canonical name = the file/dir basename (not the frontmatter name). */
  name:        string;
  description: string;
  scope:       SkillScope;
  /** Human label of the dir it came from, e.g. ".axon/skills". */
  source:      string;
  /** Absolute path to the skill's Markdown file. */
  path:        string;
  /** Instruction body (frontmatter stripped, trimmed). */
  body:        string;
}

export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Split leading `---`-fenced frontmatter from the body. Returns flat string
 * key/values (lowercased keys) + the trimmed body. No fence → all body.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: raw.trim() };

  const meta: Record<string, string> = {};
  let i = 1;
  let closed = false;
  for (; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") { i++; closed = true; break; }
    const m = lines[i]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) meta[m[1]!.toLowerCase()] = stripQuotes(m[2]!);
  }
  if (!closed) return { meta: {}, body: raw.trim() }; // unterminated fence → treat as plain body
  return { meta, body: lines.slice(i).join("\n").trim() };
}

/** Read a skill file, rejecting symlinks / non-files / oversized files. Null on any error. */
function safeRead(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > MAX_SKILL_BYTES) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

interface SkillDir { dir: string; scope: SkillScope; label: string; }

/** The three skill directories, lowest precedence first. */
function skillDirs(cwd: string): SkillDir[] {
  return [
    { dir: join(configDir(), "skills"),   scope: "global",  label: "~/.axon/skills" },
    { dir: join(cwd, ".claude", "skills"), scope: "project", label: ".claude/skills" },
    { dir: join(cwd, ".axon", "skills"),   scope: "project", label: ".axon/skills" },
  ];
}

function readSkillDir(d: SkillDir): Skill[] {
  if (!existsSync(d.dir)) return [];
  let entries;
  try { entries = readdirSync(d.dir, { withFileTypes: true }); } catch { return []; }

  const out: Skill[] = [];
  for (const e of entries) {
    let name: string | null = null;
    let file: string | null = null;

    if (e.isFile() && /\.md$/i.test(e.name) && e.name.toLowerCase() !== "skill.md") {
      name = e.name.replace(/\.md$/i, "");
      file = join(d.dir, e.name);
    } else if (e.isDirectory()) {
      const candidate = join(d.dir, e.name, "SKILL.md");
      if (existsSync(candidate)) { name = e.name; file = candidate; }
    }
    if (!name || !file || !isValidSkillName(name)) continue;

    const raw = safeRead(file);
    if (raw === null) continue;
    const { meta, body } = parseFrontmatter(raw);
    out.push({
      name,
      description: meta.description ?? "",
      scope:       d.scope,
      source:      d.label,
      path:        file,
      body,
    });
  }
  return out;
}

/** All discoverable skills, name-sorted, higher-precedence dirs winning collisions. */
export function discoverSkills(cwd: string = process.cwd()): Skill[] {
  const byName = new Map<string, Skill>();
  for (const d of skillDirs(cwd)) {
    for (const s of readSkillDir(d)) byName.set(s.name, s); // later dir wins
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a single skill by name (highest precedence). Null if missing/invalid name. */
export function findSkill(name: string, cwd: string = process.cwd()): Skill | null {
  if (!isValidSkillName(name)) return null;
  return discoverSkills(cwd).find((s) => s.name === name) ?? null;
}

/** Absolute path where `axon skill add <name>` scaffolds a new skill. */
export function newSkillPath(name: string): string {
  return join(configDir(), "skills", name, "SKILL.md");
}
