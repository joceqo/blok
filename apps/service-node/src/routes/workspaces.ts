import { asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DbVariables } from '../middleware/db.js';
import type { SessionVariables } from '../middleware/session.js';
import { requireUser } from '../middleware/require-user.js';
import { withTransaction } from '../db/transaction.js';
import { workspaces, workspaceMembers } from '../db/schema.js';
import { slugFromName } from '../workspaces/slug.js';

type Env = { Variables: DbVariables & SessionVariables };

/**
 * Workspace list + detail — flat paths like Go (`GET /api/workspaces`, `GET /api/workspaces/:id`).
 */
export const workspaceRoutes = new Hono<Env>();

workspaceRoutes.post('/api/workspaces', requireUser(), async (context) => {
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const body: { name?: string; slug?: string } = await context.req
    .json<{ name?: string; slug?: string }>()
    .catch(() => ({}));
  const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : 'Workspace';
  const slug =
    typeof body.slug === 'string' && body.slug.trim().length > 0
      ? body.slug.trim().toLowerCase()
      : slugFromName(name);

  const db = context.get('db');
  try {
    const created = await withTransaction(db, async (tx) => {
      const inserted = await tx
        .insert(workspaces)
        .values({ name, slug })
        .returning();
      const workspace = inserted[0];
      if (workspace === undefined) {
        throw new Error('insert_failed');
      }
      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId,
        role: 'owner',
      });
      return workspace;
    });
    return context.json({ workspace: created }, 201);
  } catch {
    return context.json({ error: 'slug_taken_or_failed' }, 409);
  }
});

workspaceRoutes.get('/api/workspaces', async (context) => {
  const db = context.get('db');

  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .orderBy(asc(workspaces.name));

  return context.json({ workspaces: rows });
});

workspaceRoutes.get('/api/workspaces/:workspaceId', async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const workspace = rows[0];
  if (workspace === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ workspace });
});

/**
 * Example of raw SQL for locks the query builder does not express yet (plan: `sql` escape hatch).
 */
workspaceRoutes.get('/api/workspaces/:workspaceId/members', async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  const members = await db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  // Advisory lock example only — no-op read; real handlers run inside a transaction.
  await db.execute(sql`SELECT pg_advisory_xact_lock(774839102)`);

  return context.json({ members });
});