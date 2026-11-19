import { asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DbVariables } from '../middleware/db.js';
import { workspaces, workspaceMembers } from '../db/schema.js';

type Env = { Variables: DbVariables };

/**
 * Workspace list + detail — flat paths like Go (`GET /api/workspaces`, `GET /api/workspaces/:id`).
 */
export const workspaceRoutes = new Hono<Env>();

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