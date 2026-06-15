/**
 * Diff applier (src/diff.ts computeUpdatedContent). The big regression guard:
 * an `edit_file` whose search block matches more than one location must be
 * refused, not silently applied to the first hit.
 */

import { describe, it, expect } from "vitest";
import { computeUpdatedContent } from "../src/diff.js";

const edit = (search: string, replace: string) => ({ filePath: "x.ts", search, replace });

describe("computeUpdatedContent", () => {
  it("replaces a unique exact match", () => {
    expect(computeUpdatedContent("a\nfoo\nb\n", edit("foo", "bar"))).toBe("a\nbar\nb\n");
  });

  it("throws on a duplicate exact match (ambiguous)", () => {
    expect(() => computeUpdatedContent("foo\nfoo\n", edit("foo", "bar"))).toThrow(/ambiguous/i);
  });

  it("throws when the block is not found", () => {
    expect(() => computeUpdatedContent("a\nb\n", edit("zzz", "q"))).toThrow(/did not match/i);
  });

  it("matches across CRLF/LF differences", () => {
    const out = computeUpdatedContent("x\r\nfoo\r\ny\r\n", edit("foo", "bar"));
    expect(out).toContain("bar");
    expect(out).not.toContain("foo");
  });

  it("applies a unique whitespace-normalised match (indentation drift)", () => {
    // Source has no indentation; the search block is indented → exact miss,
    // normalised hit.
    const out = computeUpdatedContent("x\nreturn 1\ny\n", edit("    return 1", "return 2"));
    expect(out).toContain("return 2");
    expect(out).not.toContain("return 1");
  });

  it("throws on a duplicate whitespace-normalised match", () => {
    const src = "return 1\nx\nreturn 1\n";
    expect(() => computeUpdatedContent(src, edit("    return 1", "return 2"))).toThrow(/ambiguous/i);
  });

  it("CRITICAL: refuses an empty search block (would overwrite the whole file)", () => {
    expect(() => computeUpdatedContent("def f():\n    return 1\n", edit("", "x"))).toThrow(/empty/i);
    expect(() => computeUpdatedContent("hello\n", edit("   ", "x"))).toThrow(/empty/i);
  });
});
