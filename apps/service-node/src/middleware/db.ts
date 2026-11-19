import { createMiddleware } from 'hono/factory';

import type { Database } from '../db/index.js';

export type DbVariables = {
  db: Database;
};

export function dbMiddleware(db: Database) {
  return createMiddleware<{ Variables: DbVariables }>(async (context, next) => {
    context.set('db', db);
    await next();
  });
}