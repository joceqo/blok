import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { and, eq, gt } from 'drizzle-orm';

import { SESSION_COOKIE, hashSecret } from '../auth/codes.js';
import type { Database } from '../db/index.js';
import { sessions } from '../db/schema.js';

export type SessionVariables = {
  userId: string | undefined;
};

export function sessionMiddleware(db: Database) {
  return createMiddleware<{ Variables: SessionVariables }>(async (context, next) => {
    let userId = process.env.DEV_USER_ID;

    const token = getCookie(context, SESSION_COOKIE);
    if (token !== undefined && token.length > 0) {
      const now = new Date();
      const row = (
        await db
          .select({ userId: sessions.userId })
          .from(sessions)
          .where(and(eq(sessions.tokenHash, hashSecret(token)), gt(sessions.expiresAt, now)))
          .limit(1)
      )[0];
      if (row !== undefined) {
        userId = row.userId;
      }
    }

    context.set('userId', userId);
    await next();
  });
}