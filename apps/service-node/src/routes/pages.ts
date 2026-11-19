import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { pages } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { DbVariables } from '../middleware/db.js';
import type { SessionVariables } from '../middleware/session.js';
import { assertPageAction } from '../permissions.js';

type Env = {
  Variables: DbVariables & SessionVariables;
};

/**
 * Pages in a workspace — same flat style as Go (`GET /api/pages/:id`, tree via parent_id).
 */
export const pageRoutes = new Hono<Env>();

pageRoutes.get('/api/workspaces/:workspaceId/pages', async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const role = context.get('devRole');
  assertPageAction(role, 'read');

  const db = context.get('db');
  const rows = await db
    .select({
      id: pages.id,
      title: pages.title,
      parentId: pages.parentId,
      trashed: pages.trashed,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), eq(pages.trashed, false)))
    .orderBy(asc(pages.title));

  return context.json({ pages: rows });
});

pageRoutes.get('/api/pages/:pageId', async (context) => {
  const pageId = context.req.param('pageId');
  const role = context.get('devRole');
  assertPageAction(role, 'read');

  const db = context.get('db');
  const rows = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  const page = rows[0];
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ page });
});

pageRoutes.post('/api/workspaces/:workspaceId/pages', async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const role = context.get('devRole');
  assertPageAction(role, 'edit');

  const body: { title?: string; parentId?: string | null } = await context.req
    .json<{ title?: string; parentId?: string | null }>()
    .catch(() => ({}));
  const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : 'Untitled';
  const parentId = body.parentId === null || body.parentId === undefined ? null : body.parentId;

  const db = context.get('db');
  const created = await withTransaction(db, async (tx) => {
    const inserted = await tx
      .insert(pages)
      .values({
        workspaceId,
        title,
        parentId,
        trashed: false,
        updatedAt: new Date(),
      })
      .returning();

    return inserted[0];
  });

  if (created === undefined) {
    return context.json({ error: 'insert_failed' }, 500);
  }

  return context.json({ page: created }, 201);
});

pageRoutes.patch('/api/pages/:pageId', async (context) => {
  const pageId = context.req.param('pageId');
  const role = context.get('devRole');
  assertPageAction(role, 'edit');

  const body: { title?: string; trashed?: boolean } = await context.req
    .json<{ title?: string; trashed?: boolean }>()
    .catch(() => ({}));
  const db = context.get('db');

  const patch: { title?: string; trashed?: boolean; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (typeof body.title === 'string') {
    patch.title = body.title.trim();
  }
  if (typeof body.trashed === 'boolean') {
    if (body.trashed) {
      assertPageAction(role, 'trash');
    } else {
      assertPageAction(role, 'restore');
    }
    patch.trashed = body.trashed;
  }

  const updated = await db.update(pages).set(patch).where(eq(pages.id, pageId)).returning();
  const page = updated[0];
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ page });
});