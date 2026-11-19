import { Hono } from 'hono';

import { forwardToSidecar } from '../sidecar/client.js';

/**
 * Product document routes — HTTP sync state via the collaboration sidecar.
 * WebSocket upgrade for live sync stays on `/api/blok/sync/:docId`.
 */
export function createDocumentsRoutes(): Hono {
  const documentsRoutes = new Hono();

  documentsRoutes.get('/api/documents/:docId/state', (context) => {
    const docId = context.req.param('docId');
    return forwardToSidecar(
      `/sync/${docId}/state`,
      context.req.raw,
      new URL(context.req.url),
    );
  });

  return documentsRoutes;
}