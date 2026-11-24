import { Hono } from 'hono';

import { mintDocumentStateAuthorization } from '../documents/ticket-forward.ts';
import type { SessionVariables } from '../middleware/session.ts';
import { forwardToSidecar } from '../sidecar/client.ts';

type Env = { Variables: SessionVariables };

/**
 * Product document routes — HTTP sync state via the collaboration sidecar.
 * WebSocket upgrade for live sync stays on `/api/blok/sync/:docId`.
 */
export function createDocumentsRoutes(): Hono<Env> {
  const documentsRoutes = new Hono<Env>();

  documentsRoutes.get('/api/documents/:docId/state', async (context) => {
    const docId = context.req.param('docId');
    const incomingAuth = context.req.header('authorization');

    let request = context.req.raw;
    if (incomingAuth === undefined || incomingAuth.length === 0) {
      const userId = context.get('userId');
      if (userId !== undefined) {
        const auth = mintDocumentStateAuthorization(userId, docId);
        if (auth === undefined) {
          return context.json({ error: 'blok_secret_not_configured' }, 503);
        }
        const headers = new Headers(context.req.raw.headers);
        headers.set('authorization', auth);
        request = new Request(context.req.raw.url, {
          method: context.req.method,
          headers,
        });
      }
    }

    return forwardToSidecar(`/sync/${docId}/state`, request, new URL(context.req.url));
  });

  return documentsRoutes;
}