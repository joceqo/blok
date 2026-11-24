import type { users } from '../db/schema.ts';

type UserRow = typeof users.$inferSelect;

export function toUserJson(user: Pick<UserRow, 'id' | 'email' | 'displayName'>) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? null,
  };
}