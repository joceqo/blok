import { and, asc, eq, gt, or } from 'drizzle-orm';
import { Hono } from 'hono';

import { pages } from '@/db/schema.js';
import { withTransaction } from '@/db/transaction.js';
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  parseListPagination,
} from '@/http/pagination.js';
import { requireWorkspaceRole } from '@/http/workspace-access.js';
import type { DbVariables } from '@/middleware/db.js';
import { requireUser } from '@/middleware/require-user.js';
import type { SessionVariables } from '@/middleware/session.js';
import { duplicateTitle } from '@/pages/duplicate-title.js';
import {
  buildPagesTree,
  wouldCreatePageCycle,
} from '@/pages/tree.js';
import { assertPageAction } from '@/permissions.js';
import { memberRole } from '@/workspaces/membership.js';

type Env = {
  Variables: DbVariables & SessionVariables;
};

export const pageRoutes = new Hono<Env>();

pageRoutes.get('/api/workspaces/:workspaceId/pages', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'read');

  const pagination = parseListPagination(context.req.query());
  const workspaceFilter = and(eq(pages.workspaceId, workspaceId), eq(pages.trashed, false));

  const baseSelect = db
    .select({
      id: pages.id,
      title: pages.title,
      parentId: pages.parentId,
      trashed: pages.trashed,
      updatedAt: pages.updatedAt,
    })
    .from(pages);

  if (!pagination.paginated) {
    const rows = await baseSelect
      .where(workspaceFilter)
      .orderBy(asc(pages.title));
    return context.json({ pages: rows });
  }

  let cursorFilter = workspaceFilter;
  if (pagination.cursor !== undefined) {
    let decoded: { at: Date; id: string };
    try {
      decoded = decodeTimeIdCursor(pagination.cursor);
    } catch {
      return context.json({ error: 'invalid_cursor' }, 400);
    }
    const afterCursor = or(
      gt(pages.updatedAt, decoded.at),
      and(eq(pages.updatedAt, decoded.at), gt(pages.id, decoded.id)),
    );
    cursorFilter = and(workspaceFilter, afterCursor);
  }

  const rows = await baseSelect
    .where(cursorFilter)
    .orderBy(asc(pages.updatedAt), asc(pages.id))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const pagesPage = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = pagesPage.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeTimeIdCursor(last.updatedAt, last.id)
      : undefined;

  return context.json({
    pages: pagesPage,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
});

pageRoutes.get('/api/workspaces/:workspaceId/pages/trash', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'read');

  const rows = await db
    .select({
      id: pages.id,
      title: pages.title,
      parentId: pages.parentId,
      trashed: pages.trashed,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), eq(pages.trashed, true)))
    .orderBy(asc(pages.updatedAt));

  return context.json({ pages: rows });
});

pageRoutes.get(
  '/api/workspaces/:workspaceId/pages/tree',
  requireUser(),
  async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const db = context.get('db');

    await requireWorkspaceRole(db, context, workspaceId, 'read');

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

    const tree = buildPagesTree(rows);
    return context.json({ tree });
  },
);

pageRoutes.get('/api/pages/:pageId', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const rows = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  const page = rows[0];
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const role = await memberRole(db, userId, page.workspaceId);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }
  try {
    assertPageAction(role, 'read');
  } catch {
    return context.json({ error: 'permission_denied' }, 403);
  }

  return context.json({ page });
});

pageRoutes.post('/api/workspaces/:workspaceId/pages', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'edit');

  const body: { title?: string; parentId?: string | null } = await context.req
    .json<{ title?: string; parentId?: string | null }>()
    .catch(() => ({}));
  const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : 'Untitled';
  const parentId = body.parentId === null || body.parentId === undefined ? null : body.parentId;

  if (parentId !== null) {
    const parent = (
      await db
        .select()
        .from(pages)
        .where(and(eq(pages.id, parentId), eq(pages.workspaceId, workspaceId)))
        .limit(1)
    )[0];
    if (parent === undefined) {
      return context.json({ error: 'invalid_parent' }, 400);
    }
  }

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

pageRoutes.patch('/api/pages/:pageId', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const existing = (await db.select().from(pages).where(eq(pages.id, pageId)).limit(1))[0];
  if (existing === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const role = await memberRole(db, userId, existing.workspaceId);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const body: { title?: string; trashed?: boolean } = await context.req
    .json<{ title?: string; trashed?: boolean }>()
    .catch(() => ({}));

  const patch: { title?: string; trashed?: boolean; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (typeof body.title === 'string') {
    try {
      assertPageAction(role, 'edit');
    } catch {
      return context.json({ error: 'permission_denied' }, 403);
    }
    patch.title = body.title.trim();
  }
  if (typeof body.trashed === 'boolean') {
    try {
      assertPageAction(role, body.trashed ? 'trash' : 'restore');
    } catch {
      return context.json({ error: 'permission_denied' }, 403);
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

pageRoutes.post('/api/pages/:pageId/duplicate', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const source = (await db.select().from(pages).where(eq(pages.id, pageId)).limit(1))[0];
  if (source === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const role = await memberRole(db, userId, source.workspaceId);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }
  try {
    assertPageAction(role, 'edit');
  } catch {
    return context.json({ error: 'permission_denied' }, 403);
  }

  const title = duplicateTitle(source.title);

  const created = await withTransaction(db, async (tx) => {
    const inserted = await tx
      .insert(pages)
      .values({
        workspaceId: source.workspaceId,
        title,
        parentId: source.parentId,
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

pageRoutes.post('/api/pages/:pageId/move', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');

  const body: { parentId?: string | null; workspaceId?: string } = await context.req
    .json<{ parentId?: string | null; workspaceId?: string }>()
    .catch(() => ({}));

  const workspaceId =
    typeof body.workspaceId === 'string' && body.workspaceId.length > 0
      ? body.workspaceId
      : undefined;
  if (workspaceId === undefined) {
    return context.json({ error: 'invalid_workspace' }, 400);
  }

  await requireWorkspaceRole(db, context, workspaceId, 'move');

  const existing = (await db.select().from(pages).where(eq(pages.id, pageId)).limit(1))[0];
  if (existing === undefined || existing.workspaceId !== workspaceId) {
    return context.json({ error: 'not_found' }, 404);
  }

  const parentId =
    body.parentId === null || body.parentId === undefined ? null : body.parentId;

  if (parentId !== null) {
    const parent = (
      await db
        .select()
        .from(pages)
        .where(and(eq(pages.id, parentId), eq(pages.workspaceId, workspaceId)))
        .limit(1)
    )[0];
    if (parent === undefined) {
      return context.json({ error: 'invalid_parent' }, 400);
    }
  }

  const workspacePages = await db
    .select({ id: pages.id, parentId: pages.parentId })
    .from(pages)
    .where(eq(pages.workspaceId, workspaceId));

  if (wouldCreatePageCycle(pageId, parentId, workspacePages)) {
    return context.json({ error: 'cycle' }, 400);
  }

  const updated = await db
    .update(pages)
    .set({ parentId, updatedAt: new Date() })
    .where(eq(pages.id, pageId))
    .returning();
  const page = updated[0];
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ page });
});

pageRoutes.delete('/api/pages/:pageId', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const existing = (await db.select().from(pages).where(eq(pages.id, pageId)).limit(1))[0];
  if (existing === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const role = await memberRole(db, userId, existing.workspaceId);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }
  try {
    assertPageAction(role, 'delete');
  } catch {
    return context.json({ error: 'permission_denied' }, 403);
  }

  const child = (
    await db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.parentId, pageId))
      .limit(1)
  )[0];
  if (child !== undefined) {
    return context.json({ error: 'has_children' }, 400);
  }

  const removed = await db.delete(pages).where(eq(pages.id, pageId)).returning({ id: pages.id });
  if (removed[0] === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ deleted: pageId });
});