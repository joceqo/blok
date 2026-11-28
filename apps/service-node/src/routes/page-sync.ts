import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Database } from '../db/index.ts';
import { pageDocuments, pages } from '../db/schema.ts';
import { requireWorkspaceRole } from '../http/workspace-access.ts';
import type { DbVariables } from '../middleware/db.ts';
import { requireUser } from '../middleware/require-user.ts';
import type { SessionVariables } from '../middleware/session.ts';
import { mintDocumentStateAuthorization } from '../documents/ticket-forward.ts';
import { forwardToSidecar } from '../sidecar/client.ts';

type Env = { Variables: DbVariables & SessionVariables };

export const pageSyncRoutes = new Hono<Env>();

pageSyncRoutes.get('/api/pages/:pageId/sync/state', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const page = (await db.select().from(pages).where(eq(pages.id, pageId)).limit(1))[0];
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  await requireWorkspaceRole(db, context, page.workspaceId, 'read');

  const binding = (
    await db.select().from(pageDocuments).where(eq(pageDocuments.pageId, pageId)).limit(1)
  )[0];
  if (binding === undefined) {
    return context.json({ error: 'document_not_bound' }, 404);
  }

  const auth = mintDocumentStateAuthorization(userId, binding.docId);
  if (auth === undefined) {
    return context.json({ error: 'blok_secret_not_configured' }, 503);
  }

  const headers = new Headers(context.req.raw.headers);
  headers.set('authorization', auth);

  const proxied = new Request(context.req.raw.url, {
    method: 'GET',
    headers,
  });

  return forwardToSidecar(`/sync/${binding.docId}/state`, proxied, new URL(context.req.url));
});