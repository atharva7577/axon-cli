/**
 * Skill discovery (src/skills/discovery.ts). Covers the frontmatter parser,
 * directory precedence, and the security guards: a traversal-y skill name is
 * rejected without touching disk, and symlinked skill files are not ingested.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import {
  tmpTree, cleanupAll, withConfigDir, writeFileDeep, ensureDir, canSymlink, makeSymlink,
} from "./helpers.js";
import {
  parseFrontmatter, isValidSkillName, discoverSkills, findSkill,
} from "../src/skills/discovery.js";

afterEach(() => cleanupAll());

describe("parseFrontmatter", () => {
  it("splits frontmatter from body", () => {
    const { meta, body } = parseFrontmatter("---\nname: foo\ndescription: does X\n---\n\n# Foo\nbody");
    expect(meta.name).toBe("foo");
    expect(meta.description).toBe("does X");
    expect(body).toBe("# Foo\nbody");
  });

  it("strips surrounding quotes from values", () => {
    expect(parseFrontmatter(`---\ndescription: "quoted"\n---\nx`).meta.description).toBe("quoted");
  });

  it("treats content with no fence as all body", () => {
    const { meta, body } = parseFrontmatter("# Just markdown\nno frontmatter");
    expect(meta).toEqual({});
    expect(body).toBe("# Just markdown\nno frontmatter");
  });

  it("treats an unterminated fence as plain body (no partial meta)", () => {
    expect(parseFrontmatter("---\nname: foo\nno closing fence").meta).toEqual({});
  });
});

describe("isValidSkillName", () => {
  it("accepts safe names and rejects traversal / separators / spaces", () => {
    expect(isValidSkillName("my-skill_1")).toBe(true);
    expect(isValidSkillName("../etc")).toBe(false);
    expect(isValidSkillName("a/b")).toBe(false);
    expect(isValidSkillName("a\\b")).toBe(false);
    expect(isValidSkillName("has space")).toBe(false);
    expect(isValidSkillName("")).toBe(false);
  });
});

describe("discoverSkills", () => {
  it("finds both <name>.md and <name>/SKILL.md, with parsed descriptions", () => {
    const restore = withConfigDir(tmpTree());
    const proj = tmpTree();
    try {
      writeFileDeep(join(proj, ".axon", "skills", "alpha.md"), "---\ndescription: A\n---\ndo a");
      writeFileDeep(join(proj, ".axon", "skills", "beta", "SKILL.md"), "---\ndescription: B\n---\ndo b");
      const found = discoverSkills(proj);
      expect(found.map((s) => s.name)).toEqual(["alpha", "beta"]);
      expect(found.find((s) => s.name === "alpha")?.description).toBe("A");
    } finally {
      restore();
    }
  });

  it("discovers a .claude/skills skill (compat)", () => {
    const restore = withConfigDir(tmpTree());
    const proj = tmpTree();
    try {
      writeFileDeep(join(proj, ".claude", "skills", "review", "SKILL.md"), "---\ndescription: review\n---\ngo");
      expect(discoverSkills(proj).map((s) => s.name)).toContain("review");
    } finally {
      restore();
    }
  });

  it("project .axon/skills overrides global on a name collision", () => {
    const cfg = tmpTree();
    const restore = withConfigDir(cfg);
    const proj = tmpTree();
    try {
      writeFileDeep(join(cfg, "skills", "dup.md"), "---\ndescription: global\n---\ng");
      writeFileDeep(join(proj, ".axon", "skills", "dup.md"), "---\ndescription: project\n---\np");
      const dup = discoverSkills(proj).filter((s) => s.name === "dup");
      expect(dup).toHaveLength(1);
      expect(dup[0]!.description).toBe("project");
      expect(dup[0]!.scope).toBe("project");
    } finally {
      restore();
    }
  });

  it("does not ingest a symlinked skill file", () => {
    if (!canSymlink()) return;
    const restore = withConfigDir(tmpTree());
    const proj = tmpTree();
    const outside = tmpTree();
    try {
      const secret = join(outside, "secret.md");
      writeFileDeep(secret, "---\ndescription: leaked\n---\nx");
      ensureDir(join(proj, ".axon", "skills"));
      makeSymlink(secret, join(proj, ".axon", "skills", "evil.md"));
      expect(discoverSkills(proj).find((s) => s.name === "evil")).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("findSkill", () => {
  it("returns null for an invalid (traversal) name", () => {
    expect(findSkill("../../etc/passwd", tmpTree())).toBeNull();
  });
});
