import { Hono } from 'hono';
import { proxy } from 'hono/proxy';

function sidecarBaseUrl(): string | undefined {
  const raw = process.env.BLOK_SIDECAR_URL;
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

async function forwardToSidecar(context: { req: { url: string; raw: Request; path: string } }): Promise<Response> {
  const base = sidecarBaseUrl();
  if (base === undefined) {
    return Response.json(
      {
        error: 'sidecar_not_configured',
        hint: 'Set BLOK_SIDECAR_URL to the blok-server base (e.g. http://127.0.0.1:4000)',
      },
      { status: 501 },
    );
  }

  const incoming = new URL(context.req.url);
  const stripped = context.req.path.replace(/^\/api\/blok/, '') || '/';
  const target = new URL(stripped + incoming.search, `${base}/`);

  return proxy(target.toString(), context.req.raw);
}

/**
 * Collaboration sidecar at `/api/blok` — reverse proxy when `BLOK_SIDECAR_URL` is set.
 */
export function createBlokRoutes(): Hono {
  const blokRoutes = new Hono();

  blokRoutes.all('/api/blok', (context) => forwardToSidecar(context));
  blokRoutes.all('/api/blok/*', (context) => forwardToSidecar(context));

  return blokRoutes;
}