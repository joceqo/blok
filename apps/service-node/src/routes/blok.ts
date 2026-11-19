import { Hono } from 'hono';

/**
 * Blok collaboration sidecar mount — proxies to `packages/server/node` later.
 * Product host typically mounts this at `/api/blok` (same as ASP.NET MapBlokServer).
 */
export const blokRoutes = new Hono();

blokRoutes.all('/api/blok/*', (context) => {
  return context.json(
    {
      error: 'sidecar_not_mounted',
      hint: 'Embed packages/server/node or set BLOK_SIDECAR_URL',
      path: context.req.path,
    },
    501,
  );
});