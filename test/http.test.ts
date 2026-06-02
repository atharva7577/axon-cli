/**
 * HTTPS enforcement (src/http.ts assertSecureBase). The bearer key / device code
 * must never travel to a plaintext backend — except an explicit local dev host
 * or under AXON_ALLOW_INSECURE=1.
 */

import { describe, it, expect, afterEach } from "vitest";
import { assertSecureBase } from "../src/http.js";

afterEach(() => { delete process.env.AXON_ALLOW_INSECURE; });

describe("assertSecureBase", () => {
  it("allows https", () => {
    expect(() => assertSecureBase("https://api.axon.nexalyte.tech")).not.toThrow();
  });

  it("allows http only for localhost / 127.0.0.1", () => {
    expect(() => assertSecureBase("http://localhost:8080")).not.toThrow();
    expect(() => assertSecureBase("http://127.0.0.1:3000")).not.toThrow();
  });

  it("rejects http to a public host", () => {
    expect(() => assertSecureBase("http://evil.example.com")).toThrow(/non-HTTPS/i);
  });

  it("AXON_ALLOW_INSECURE=1 overrides", () => {
    process.env.AXON_ALLOW_INSECURE = "1";
    expect(() => assertSecureBase("http://evil.example.com")).not.toThrow();
  });

  it("rejects a malformed base", () => {
    expect(() => assertSecureBase("not a url")).toThrow();
  });
});
