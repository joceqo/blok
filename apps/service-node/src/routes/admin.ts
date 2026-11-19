import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DbVariables } from '../middleware/db.js';
import { requireAdmin } from '../middleware/admin.js';
import { requireUser } from '../middleware/require-user.js';
import type { SessionVariables } from '../middleware/session.js';
import { users, workspaces } from '../db/schema.js';

type Env = { Variables: DbVariables & SessionVariables };

/**
 * Admin routes — mirror Go flat style: `GET /api/admin/users/{id}`.
 * Restrict with `ADMIN_USER_IDS` (comma-separated user uuids) when set.
 */
export const adminRoutes = new Hono<Env>();

adminRoutes.use('/api/admin/*', requireUser(), requireAdmin());

adminRoutes.get('/api/admin/users/:id', async (context) => {
  const id = context.req.param('id');
  const db = context.get('db');

  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const user = rows[0];
  if (user === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ user: { id: user.id, email: user.email, createdAt: user.createdAt } });
});

adminRoutes.get('/api/admin/users', async (context) => {
  const db = context.get('db');
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.createdAt));

  return context.json({ users: rows });
});

adminRoutes.get('/api/admin/workspaces', async (context) => {
  const db = context.get('db');
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt));

  return context.json({ workspaces: rows });
});