import { createMiddleware } from 'hono/factory';

import type { SessionVariables } from './session.js';

export function requireUser() {
  return createMiddleware<{ Variables: SessionVariables }>(async (context, next) => {
    if (context.get('userId') === undefined) {
      return context.json({ error: 'unauthenticated' }, 401);
    }
    await next();
  });
}