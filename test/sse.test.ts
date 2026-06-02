/**
 * SSE parser robustness (src/sse.ts streamChat). A backend that never sends an
 * event boundary must not be able to grow our reassembly buffer without bound,
 * and a single malformed `data:` line must be skipped rather than killing the
 * stream. fetch is stubbed so no real network is touched.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpTree, cleanupAll, withConfigDir } from "./helpers.js";
import { streamChat } from "../src/sse.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupAll();
});

/** Isolated config dir with a dummy key so streamChat's readConfig() is sandboxed. */
function sandbox(): () => void {
  const dir = tmpTree();
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    apiBase: "https://x.test", apiKey: "axon_test", defaultModel: "auto", telemetry: false,
  }));
  return withConfigDir(dir);
}

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
}

const OPTS = { apiBase: "https://x.test", apiKey: "axon_test" };

describe("streamChat", () => {
  it("throws when the buffer passes the cap with no event boundary", async () => {
    const restore = sandbox();
    const big = "data: " + "x".repeat(1_100_000); // > 1 MB, no \n\n
    vi.stubGlobal("fetch", async () => new Response(bodyOf([big]), { status: 200 }));
    try {
      await expect((async () => {
        for await (const _ev of streamChat({ messages: [] }, OPTS)) { /* drain */ }
      })()).rejects.toThrow(/SSE buffer exceeded/i);
    } finally {
      restore();
    }
  });

  it("skips a malformed data line and still yields valid deltas", async () => {
    const restore = sandbox();
    const chunks = [
      "data: {not json}\n\n",
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal("fetch", async () => new Response(bodyOf(chunks), { status: 200 }));
    try {
      const texts: string[] = [];
      for await (const ev of streamChat({ messages: [] }, OPTS)) {
        if (ev.type === "delta") texts.push(ev.text);
      }
      expect(texts.join("")).toBe("hi");
    } finally {
      restore();
    }
  });
});
