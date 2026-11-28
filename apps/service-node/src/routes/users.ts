import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { normalizeDisplayName } from '../auth/display-name.ts';
import { toUserJson } from '../auth/serialize-user.ts';
import { users } from '../db/schema.ts';
import type { DbVariables } from '../middleware/db.ts';
import { requireUser } from '../middleware/require-user.ts';
import type { SessionVariables } from '../middleware/session.ts';

type Env = { Variables: DbVariables & SessionVariables };

export function createUserRoutes(): Hono<Env> {
  const userRoutes = new Hono<Env>();

  userRoutes.patch('/api/users/me', requireUser(), async (context) => {
    const userId = context.get('userId');
    if (userId === undefined) {
      return context.json({ error: 'unauthenticated' }, 401);
    }

    const body: { displayName?: string | null } = await context.req
      .json<{ displayName?: string | null }>()
      .catch(() => ({}));

    if (!('displayName' in body)) {
      return context.json({ error: 'invalid_request' }, 400);
    }

    const raw = body.displayName;
    if (raw !== null && typeof raw !== 'string') {
      return context.json({ error: 'invalid_display_name' }, 400);
    }

    const normalized = normalizeDisplayName(raw ?? null);
    if (!normalized.ok) {
      return context.json({ error: normalized.reason }, 400);
    }

    const db = context.get('db');
    const updated = await db
      .update(users)
      .set({ displayName: normalized.value })
      .where(eq(users.id, userId))
      .returning();

    const user = updated[0];
    if (user === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    return context.json({ user: toUserJson(user) });
  });

  return userRoutes;
}