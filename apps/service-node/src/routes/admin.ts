import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DbVariables } from '../middleware/db.js';
import { users } from '../db/schema.js';

type Env = { Variables: DbVariables };

/**
 * Admin routes — mirror Go flat style: `GET /api/admin/users/{id}`.
 */
export const adminRoutes = new Hono<Env>();

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