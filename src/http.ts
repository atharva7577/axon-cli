/**
 * http.ts — Bearer-aware JSON HTTP wrapper around the AXON backend.
 *
 * Ported and trimmed from
 *   vscode-extension/src/bridge/BackendClient.ts
 * The CLI doesn't share the VS Code config surface, so we keep this small:
 * just signed GET/POST helpers that read the AXON config and surface
 * structured backend errors with code + type + message.
 */

import { readConfig, type AxonConfig } from "./config.js";

export class AxonBackendError extends Error {
  readonly status:   number;
  readonly code:     string;
  readonly type:     string;
  readonly provider: string | undefined;
  readonly raw:      unknown;
  constructor(opts: { status: number; code: string; type: string; message: string; provider?: string; raw: unknown }) {
    super(opts.message);
    this.name     = "AxonBackendError";
    this.status   = opts.status;
    this.code     = opts.code;
    this.type     = opts.type;
    this.provider = opts.provider;
    this.raw      = opts.raw;
  }
}

export interface HttpOptions {
  /** Force a different config than the one on disk (used by `axon login` mid-flow). */
  cfg?:        AxonConfig;
  /** Send `Authorization: Bearer <apiKey>`. Default true when an api key is present. */
  auth?:       boolean;
  /** Send `X-Admin-Secret` instead of the bearer. Default false. */
  admin?:      boolean;
  /** AbortSignal for cancellation. */
  signal?:     AbortSignal;
  /** Extra headers (BYOK keys, custom ids). */
  headers?:    Record<string, string>;
  /** Override timeout in ms (default 30s, login/poll routes use longer). */
  timeoutMs?:  number;
}

export interface JsonResult<T> {
  data:    T;
  status:  number;
  /** Full response object, in case the caller needs headers. */
  raw:     Response;
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

function buildHeaders(cfg: AxonConfig, opts: HttpOptions): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept":       "application/json",
    "User-Agent":   `axon-cli/${process.env.npm_package_version ?? "dev"} node/${process.versions.node}`,
  };
  if (opts.admin) {
    if (!cfg.adminSecret) throw new Error("admin requested but no adminSecret in config. Run `axon config set adminSecret <secret>`.");
    h["X-Admin-Secret"] = cfg.adminSecret;
  } else if (opts.auth !== false && cfg.apiKey) {
    h["Authorization"] = `Bearer ${cfg.apiKey}`;
  }
  return { ...h, ...(opts.headers ?? {}) };
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function toBackendError(status: number, body: unknown): AxonBackendError {
  const err = (body as { error?: { message?: string; code?: string; type?: string; provider?: string } } | null)?.error ?? {};
  return new AxonBackendError({
    status,
    code:    err.code    ?? `http_${status}`,
    type:    err.type    ?? "server_error",
    message: err.message ?? `HTTP ${status}`,
    provider: err.provider,
    raw:     body,
  });
}

async function send<T>(
  method: "GET" | "POST" | "DELETE",
  path:   string,
  body:   unknown,
  opts:   HttpOptions,
): Promise<JsonResult<T>> {
  const cfg     = opts.cfg ?? readConfig();
  const base    = trimBase(cfg.apiBase);
  const url     = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = buildHeaders(cfg, opts);

  // Compose timeout + caller-provided signal.
  const ctl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ctl.abort((opts.signal as AbortSignal | undefined)?.reason);
  opts.signal?.addEventListener("abort", onAbort);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body:   body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    throw err;
  }
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);

  const parsed = await parseBody(res);
  if (!res.ok) throw toBackendError(res.status, parsed);
  return { data: parsed as T, status: res.status, raw: res };
}

export function getJson<T>(path: string, opts: HttpOptions = {}): Promise<JsonResult<T>> {
  return send<T>("GET", path, undefined, opts);
}

export function postJson<T>(path: string, body: unknown, opts: HttpOptions = {}): Promise<JsonResult<T>> {
  return send<T>("POST", path, body, opts);
}
