import type { users } from '@/db/schema.js';

type UserRow = typeof users.$inferSelect;

export function toUserJson(user: Pick<UserRow, 'id' | 'email' | 'displayName'>) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? null,
  };
}