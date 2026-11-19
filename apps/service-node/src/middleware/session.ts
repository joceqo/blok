import { createMiddleware } from 'hono/factory';

import type { WorkspaceRole } from '../permissions.js';

/**
 * Session placeholder — real auth will set user id + role from cookie after email-code verify.
 */
export type SessionVariables = {
  userId: string | undefined;
  /** Dev-only: pretend membership role on workspace routes. */
  devRole: WorkspaceRole;
};

export function sessionMiddleware() {
  const roleFromEnv = process.env.DEV_WORKSPACE_ROLE;
  const devRole: WorkspaceRole =
    roleFromEnv === 'owner' || roleFromEnv === 'admin' || roleFromEnv === 'member' || roleFromEnv === 'guest'
      ? roleFromEnv
      : 'owner';

  return createMiddleware<{ Variables: SessionVariables }>(async (context, next) => {
    context.set('userId', process.env.DEV_USER_ID);
    context.set('devRole', devRole);
    await next();
  });
}