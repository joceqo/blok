import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { and, eq, gt } from 'drizzle-orm';

import { SESSION_COOKIE, hashSecret } from '../auth/codes.js';
import type { Database } from '../db/index.js';
import { sessions, workspaceMembers } from '../db/schema.js';
import type { WorkspaceRole } from '../permissions.js';

export type SessionVariables = {
  userId: string | undefined;
  workspaceRole: WorkspaceRole | undefined;
};

function roleFromEnv(): WorkspaceRole | undefined {
  const raw = process.env.DEV_WORKSPACE_ROLE;
  if (raw === 'owner' || raw === 'admin' || raw === 'member' || raw === 'guest') {
    return raw;
  }
  return undefined;
}

export function sessionMiddleware(db: Database) {
  return createMiddleware<{ Variables: SessionVariables }>(async (context, next) => {
    let userId = process.env.DEV_USER_ID;
    let workspaceRole = roleFromEnv();

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
        if (workspaceRole === undefined) {
          const membership = (
            await db
              .select({ role: workspaceMembers.role })
              .from(workspaceMembers)
              .where(eq(workspaceMembers.userId, row.userId))
              .limit(1)
          )[0];
          const role = membership?.role;
          if (
            role === 'owner' ||
            role === 'admin' ||
            role === 'member' ||
            role === 'guest'
          ) {
            workspaceRole = role;
          } else {
            workspaceRole = 'member';
          }
        }
      }
    }

    context.set('userId', userId);
    context.set('workspaceRole', workspaceRole);
    await next();
  });
}