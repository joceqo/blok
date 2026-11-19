import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { pageDocuments, pages } from '../db/schema.js';
import { requireWorkspaceRole } from '../http/workspace-access.js';
import type { DbVariables } from '../middleware/db.js';
import { requireUser } from '../middleware/require-user.js';
import type { SessionVariables } from '../middleware/session.js';
import { memberRole } from '../workspaces/membership.js';

type Env = { Variables: DbVariables & SessionVariables };

export const pageDocumentRoutes = new Hono<Env>();

import type { Database } from '../db/index.js';

async function loadPage(db: Database, pageId: string) {
  return (await db.select().from(pages).where(eq(pages.id, pageId)).limit(1))[0];
}

pageDocumentRoutes.get('/api/pages/:pageId/document', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const page = await loadPage(db, pageId);
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const role = await memberRole(db, userId, page.workspaceId);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  await requireWorkspaceRole(db, context, page.workspaceId, 'read');

  const binding = (
    await db.select().from(pageDocuments).where(eq(pageDocuments.pageId, pageId)).limit(1)
  )[0];

  if (binding === undefined) {
    return context.json({ document: null });
  }

  return context.json({
    document: {
      pageId: binding.pageId,
      docId: binding.docId,
      lineage: binding.lineage,
      sequence: binding.sequence.toString(),
    },
  });
});

pageDocumentRoutes.put('/api/pages/:pageId/document', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const page = await loadPage(db, pageId);
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  await requireWorkspaceRole(db, context, page.workspaceId, 'edit');

  const body: { docId?: string; lineage?: string; sequence?: string | number } = await context.req
    .json<{ docId?: string; lineage?: string; sequence?: string | number }>()
    .catch(() => ({}));

  const docId = typeof body.docId === 'string' ? body.docId.trim() : '';
  if (docId.length === 0) {
    return context.json({ error: 'invalid_doc_id' }, 400);
  }

  const lineage = typeof body.lineage === 'string' ? body.lineage : '';
  let sequence = 0n;
  if (typeof body.sequence === 'number' && Number.isInteger(body.sequence) && body.sequence >= 0) {
    sequence = BigInt(body.sequence);
  } else if (typeof body.sequence === 'string' && /^\d+$/.test(body.sequence)) {
    sequence = BigInt(body.sequence);
  }

  const saved = await db
    .insert(pageDocuments)
    .values({ pageId, docId, lineage, sequence })
    .onConflictDoUpdate({
      target: pageDocuments.pageId,
      set: { docId, lineage, sequence, updatedAt: new Date() },
    })
    .returning();

  const row = saved[0];
  if (row === undefined) {
    return context.json({ error: 'save_failed' }, 500);
  }

  return context.json({
    document: {
      pageId: row.pageId,
      docId: row.docId,
      lineage: row.lineage,
      sequence: row.sequence.toString(),
    },
  });
});