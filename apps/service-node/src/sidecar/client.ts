import { proxy } from 'hono/proxy';

/**
 * Base URL of the collaboration sidecar (`BLOK_SIDECAR_URL`), without a trailing slash.
 */
export function sidecarBaseUrl(): string | undefined {
  const raw = process.env.BLOK_SIDECAR_URL;
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

export function sidecarNotConfiguredResponse(): Response {
  return Response.json(
    {
      error: 'sidecar_not_configured',
      hint: 'Set BLOK_SIDECAR_URL to the blok-server base (e.g. http://127.0.0.1:4000)',
    },
    { status: 503 },
  );
}

/**
 * Builds an absolute sidecar URL for a path (with optional query suffix, e.g. `?foo=1`).
 */
export function buildSidecarUrl(path: string, search = ''): string | undefined {
  const base = sidecarBaseUrl();
  if (base === undefined) {
    return undefined;
  }
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return new URL(`${normalized}${search}`, `${base}/`).toString();
}

const SIDECAR_HEALTH_TIMEOUT_MS = 2_000;

/** Lightweight liveness probe against the sidecar `GET /health`. */
export async function checkSidecarReachable(): Promise<boolean> {
  const target = buildSidecarUrl('health');
  if (target === undefined) {
    return false;
  }
  try {
    const response = await fetch(target, {
      method: 'GET',
      signal: AbortSignal.timeout(SIDECAR_HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface SidecarForwardOptions {
  /**
   * When false, only `accept`, `content-type`, and `authorization` are forwarded.
   * Default: pass the incoming request through (cookies and auth headers intact).
   */
  passThroughHeaders?: boolean;
}

/**
 * Reverse-proxies an HTTP request to the sidecar at `sidecarPath` + the incoming URL search string.
 */
export async function forwardToSidecar(
  sidecarPath: string,
  incoming: Request,
  incomingUrl: URL,
  options?: SidecarForwardOptions,
): Promise<Response> {
  const target = buildSidecarUrl(sidecarPath, incomingUrl.search);
  if (target === undefined) {
    return sidecarNotConfiguredResponse();
  }

  if (options?.passThroughHeaders === false) {
    const headers = new Headers();
    for (const name of ['accept', 'content-type', 'authorization'] as const) {
      const value = incoming.headers.get(name);
      if (value !== null) {
        headers.set(name, value);
      }
    }
    const init: RequestInit = {
      method: incoming.method,
      headers,
      redirect: 'manual',
    };
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
      init.body = incoming.body;
    }
    return fetch(target, init);
  }

  return proxy(target, incoming);
}