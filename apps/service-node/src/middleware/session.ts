import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { and, eq, gt } from 'drizzle-orm';

import { hashSecret, sessionCookieName } from '../auth/codes.ts';
import type { Database } from '../db/index.ts';
import { sessions } from '../db/schema.ts';

export type SessionVariables = {
  userId: string | undefined;
};

export function sessionMiddleware(db: Database) {
  return createMiddleware<{ Variables: SessionVariables }>(async (context, next) => {
    let userId = process.env.DEV_USER_ID;

    const token = getCookie(context, sessionCookieName());
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