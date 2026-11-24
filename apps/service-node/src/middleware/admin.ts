import { createMiddleware } from 'hono/factory';

import type { SessionVariables } from './session.js';

function adminUserIds(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS;
  if (raw === undefined || raw.length === 0) {
    return new Set();
  }
  return new Set(raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0));
}

export function requireAdmin() {
  return createMiddleware<{ Variables: SessionVariables }>(async (context, next) => {
    const userId = context.get('userId');
    if (userId === undefined) {
      return context.json({ error: 'unauthenticated' }, 401);
    }
    const admins = adminUserIds();
    if (admins.size > 0 && !admins.has(userId)) {
      return context.json({ error: 'forbidden' }, 403);
    }
    await next();
  });
}