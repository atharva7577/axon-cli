/**
 * web_fetch — HTTP(S) GET with an SSRF guard + permission gate.
 *
 * Returns the body as text, truncated to 32k. The permission key is the
 * normalized hostname so "always allow github.com" lets subsequent github.com
 * fetches skip the prompt for the rest of the session.
 *
 * SSRF defence: before prompting AND on every redirect hop, the host is
 * DNS-resolved and rejected if it maps to a loopback / link-local / private /
 * ULA / CGNAT / metadata address — so a poisoned repo can't pivot the agent into
 * `http://169.254.169.254/` (cloud metadata), `http://127.0.0.1:…` (local
 * services), or an internal host, including via an open redirect on a public
 * URL. Set `AXON_ALLOW_LOCAL_FETCH=1` to override for local development.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ToolResult } from "./registry.js";
import type { PermissionStore } from "../permissions.js";

const MAX_BYTES = 32_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export interface WebFetchArgs {
  url: string;
}

/** True for any IPv4 we must not let the agent reach (private/loopback/link-local/etc.). */
function ipv4IsBlocked(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → unsafe
  const [a, b, c, d] = p as [number, number, number, number];
  if (a === 0)   return true;                       // 0.0.0.0/8  "this host"
  if (a === 10)  return true;                       // 10/8       private
  if (a === 127) return true;                       // 127/8      loopback
  if (a === 169 && b === 254) return true;          // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12  private
  if (a === 192 && b === 168) return true;          // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;// 100.64/10  CGNAT
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // broadcast
  return false;
}

/** True for any IP literal (v4 or v6) the SSRF guard must reject. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4IsBlocked(ip);
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    const mapped = lower.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped ::ffff:a.b.c.d
    if (mapped) return ipv4IsBlocked(mapped[1]!);
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7  ULA
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return true; // not a valid IP → unsafe
}

/** Normalized host for an URL: lowercased, trailing dot stripped. */
function normHost(url: URL): string {
  return url.hostname.replace(/\.$/, "").toLowerCase();
}

/**
 * Validate that a URL is safe to fetch. Returns an error string, or null if OK.
 * `allowLocal` skips the SSRF block (AXON_ALLOW_LOCAL_FETCH=1) for local dev.
 */
async function checkUrlAllowed(url: URL, allowLocal: boolean): Promise<string | null> {
  if (url.username || url.password) {
    return "URLs with embedded credentials (user:pass@host) are not allowed";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `only http/https allowed (got ${url.protocol})`;
  }
  if (allowLocal) return null;

  const host = normHost(url);
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "refusing to fetch localhost (SSRF guard; set AXON_ALLOW_LOCAL_FETCH=1 to override)";
  }
  try {
    const addrs = await lookup(host, { all: true });
    const bad = addrs.find((a) => isBlockedAddress(a.address));
    if (bad) {
      return `refusing to fetch a private/loopback/link-local address (${host} → ${bad.address}) ` +
        `— SSRF guard; set AXON_ALLOW_LOCAL_FETCH=1 to override`;
    }
  } catch (err) {
    return `cannot resolve host '${host}': ${(err as Error).message}`;
  }
  return null;
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

  const allowLocal = process.env.AXON_ALLOW_LOCAL_FETCH === "1";
  const initialErr = await checkUrlAllowed(url, allowLocal);
  if (initialErr) return { ok: false, error: `web_fetch: ${initialErr}` };

  const decision = await perms.request({
    tool:    "web_fetch",
    key:     normHost(url),
    // origin+pathname+search excludes any userinfo (rejected above) and stays readable.
    summary: `GET ${url.origin}${url.pathname}${url.search}`,
  });
  if (decision === "deny") {
    return { ok: false, error: "web_fetch: user denied permission" };
  }

  // Manual redirect loop: re-run the SSRF check on every hop so an open redirect
  // on a public URL can't bounce us into a blocked address.
  let current = url;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current.toString(), {
        method:   "GET",
        headers:  { "User-Agent": `axon-cli/${process.env.npm_package_version ?? "dev"}` },
        signal:   ctl.signal,
        redirect: "manual",
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop === MAX_REDIRECTS) {
          clearTimeout(timer);
          return { ok: false, error: `web_fetch: too many redirects (>${MAX_REDIRECTS})` };
        }
        const next = new URL(res.headers.get("location")!, current);
        const hopErr = await checkUrlAllowed(next, allowLocal);
        if (hopErr) {
          clearTimeout(timer);
          return { ok: false, error: `web_fetch: redirect to a disallowed URL — ${hopErr}` };
        }
        current = next;
        continue;
      }

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
    }
    clearTimeout(timer);
    return { ok: false, error: `web_fetch: too many redirects (>${MAX_REDIRECTS})` };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: `web_fetch: ${(err as Error).message}` };
  }
}
