import { eq } from 'drizzle-orm';

import type { Database } from '../db/index.ts';
import { users } from '../db/schema.ts';

export async function findOrCreateUserByEmail(db: Database, email: string) {
  const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (existing !== undefined) {
    return existing;
  }
  const inserted = await db.insert(users).values({ email }).returning();
  return inserted[0];
}