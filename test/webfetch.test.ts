/**
 * web_fetch SSRF guard (src/tools/webfetch.ts). The agent must not be able to
 * reach loopback / link-local / private / metadata addresses, or smuggle
 * credentials in a URL. AXON_ALLOW_LOCAL_FETCH=1 is the local-dev escape hatch.
 */

import { describe, it, expect, afterEach } from "vitest";
import { isBlockedAddress, webFetch } from "../src/tools/webfetch.js";
import { PermissionStore } from "../src/permissions.js";

const prev = process.env.AXON_ALLOW_LOCAL_FETCH;
afterEach(() => {
  if (prev === undefined) delete process.env.AXON_ALLOW_LOCAL_FETCH;
  else process.env.AXON_ALLOW_LOCAL_FETCH = prev;
});

describe("isBlockedAddress", () => {
  it("blocks loopback / private / link-local / CGNAT / metadata", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows genuine public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("webFetch guard", () => {
  it("rejects embedded credentials (user:pass@host)", async () => {
    const r = await webFetch({ url: "http://user:pass@example.com/" }, new PermissionStore());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/credentials/i);
  });

  it("rejects a loopback literal", async () => {
    delete process.env.AXON_ALLOW_LOCAL_FETCH;
    const r = await webFetch({ url: "http://127.0.0.1:9/" }, new PermissionStore());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private|loopback|SSRF/i);
  });

  it("rejects localhost by name", async () => {
    delete process.env.AXON_ALLOW_LOCAL_FETCH;
    const r = await webFetch({ url: "http://localhost:9/" }, new PermissionStore());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/localhost/i);
  });

  it("rejects the cloud metadata IP", async () => {
    delete process.env.AXON_ALLOW_LOCAL_FETCH;
    const r = await webFetch({ url: "http://169.254.169.254/latest/meta-data/" }, new PermissionStore());
    expect(r.ok).toBe(false);
  });

  it("with AXON_ALLOW_LOCAL_FETCH=1, a local URL reaches the gate (non-TTY denies)", async () => {
    process.env.AXON_ALLOW_LOCAL_FETCH = "1";
    const r = await webFetch({ url: "http://127.0.0.1:9/" }, new PermissionStore());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/denied/i); // gate, not SSRF
  });
});
