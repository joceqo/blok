import { count } from 'drizzle-orm';

import type { Database } from '../db/index.ts';
import { users } from '../db/schema.ts';

export async function countUsers(db: Database): Promise<number> {
  const row = (await db.select({ value: count() }).from(users))[0];
  return row?.value ?? 0;
}