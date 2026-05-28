/**
 * web_fetch — HTTP GET with permission gate.
 *
 * Returns the body as text, truncated to 32k. The permission key is the
 * hostname so "always allow github.com" lets subsequent github.com fetches
 * skip the prompt for the rest of the session.
 */

import type { ToolResult } from "./registry.js";
import type { PermissionStore } from "../permissions.js";

const MAX_BYTES = 32_000;
const FETCH_TIMEOUT_MS = 20_000;

export interface WebFetchArgs {
  url: string;
}

export async function webFetch(args: WebFetchArgs, perms: PermissionStore): Promise<ToolResult> {
  if (!args.url || typeof args.url !== "string") {
    return { ok: false, error: "web_fetch: 'url' is required" };
  }
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    return { ok: false, error: `web_fetch: invalid URL '${args.url}'` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `web_fetch: only http/https allowed (got ${url.protocol})` };
  }

  const decision = await perms.request({
    tool:    "web_fetch",
    key:     url.hostname,
    summary: `GET ${url.toString()}`,
  });
  if (decision === "deny") {
    return { ok: false, error: "web_fetch: user denied permission" };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method:  "GET",
      headers: { "User-Agent": `axon-cli/${process.env.npm_package_version ?? "dev"}` },
      signal:  ctl.signal,
    });
    clearTimeout(timer);
    const status = `${res.status} ${res.statusText}`;
    const ct = res.headers.get("content-type") ?? "";
    let body = await res.text();
    let truncated = false;
    if (body.length > MAX_BYTES) {
      body = body.slice(0, MAX_BYTES) + "\n… [truncated]";
      truncated = true;
    }
    return {
      ok:       res.ok,
      result:   `HTTP ${status}\nContent-Type: ${ct}\n\n${body}`,
      truncated,
      error:    res.ok ? undefined : `web_fetch: HTTP ${status}`,
    };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: `web_fetch: ${(err as Error).message}` };
  }
}
