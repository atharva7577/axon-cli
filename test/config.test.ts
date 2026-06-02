/**
 * Config atomic write (src/config.ts). A single tmp→rename means a crash leaves
 * either the old file or the new one — never a truncated/absent config — and no
 * `.tmp` is left behind.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { tmpTree, cleanupAll, withConfigDir } from "./helpers.js";
import { patchConfig, readConfig, configPath } from "../src/config.js";

afterEach(() => cleanupAll());

describe("config write", () => {
  it("round-trips and leaves no .tmp behind", () => {
    const restore = withConfigDir(tmpTree());
    try {
      patchConfig({ defaultModel: "gpt-x", tenantId: "t_123" });
      const c = readConfig();
      expect(c.defaultModel).toBe("gpt-x");
      expect(c.tenantId).toBe("t_123");
      expect(existsSync(configPath())).toBe(true);
      expect(existsSync(configPath() + ".tmp")).toBe(false);
    } finally {
      restore();
    }
  });

  it("a second write fully replaces the first with valid JSON", () => {
    const restore = withConfigDir(tmpTree());
    try {
      patchConfig({ defaultModel: "a" });
      patchConfig({ defaultModel: "b" });
      expect(() => readConfig()).not.toThrow();
      expect(readConfig().defaultModel).toBe("b");
    } finally {
      restore();
    }
  });
});
