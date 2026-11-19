import { Hono } from 'hono';

import { forwardToSidecar } from '../sidecar/client.js';

/**
 * Collaboration sidecar at `/api/blok` — reverse proxy when `BLOK_SIDECAR_URL` is set.
 */
export function createBlokRoutes(): Hono {
  const blokRoutes = new Hono();

  const forward = (context: { req: { url: string; raw: Request; path: string } }) => {
    const incoming = new URL(context.req.url);
    const stripped = context.req.path.replace(/^\/api\/blok/, '') || '/';
    return forwardToSidecar(stripped, context.req.raw, incoming);
  };

  blokRoutes.all('/api/blok', (context) => forward(context));
  blokRoutes.all('/api/blok/*', (context) => forward(context));

  return blokRoutes;
}