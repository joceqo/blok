import { count } from 'drizzle-orm';

import type { Database } from '@/db/index.js';
import { users } from '@/db/schema.js';

export async function countUsers(db: Database): Promise<number> {
  const row = (await db.select({ value: count() }).from(users))[0];
  return row?.value ?? 0;
}