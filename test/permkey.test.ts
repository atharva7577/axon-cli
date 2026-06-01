/**
 * Permission-key derivation (Balanced policy). These keys are what the gate
 * matches "always allow" against, so exactness here = the gate can't be widened
 * by a later call with different args.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { commandPermissionKey, filePermissionKey } from "../src/tools/permKey.js";

describe("commandPermissionKey (bash)", () => {
  it("is the exact command, whitespace-normalized", () => {
    expect(commandPermissionKey("npm test")).toBe("npm test");
    expect(commandPermissionKey("  npm   run   build ")).toBe("npm run build");
    expect(commandPermissionKey("   ")).toBe("(empty)");
  });

  it("distinct commands → distinct keys (no 'allow npm → any npm')", () => {
    expect(commandPermissionKey("npm test")).not.toBe(commandPermissionKey("npm run build"));
    expect(commandPermissionKey("git status")).not.toBe(commandPermissionKey("git push"));
  });
});

describe("filePermissionKey (write/edit)", () => {
  it("is the exact file path, /-normalized", () => {
    expect(filePermissionKey(join(process.cwd(), "src", "a.ts"))).toBe("src/a.ts");
  });

  it("distinct files → distinct keys (no 'allow src/ → all of src')", () => {
    const a = filePermissionKey(join(process.cwd(), "src", "a.ts"));
    const b = filePermissionKey(join(process.cwd(), "src", "b.ts"));
    expect(a).not.toBe(b);
  });
});
