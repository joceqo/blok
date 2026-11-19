/**
 * Drizzle table definitions — bootstrap subset for reading and early routes.
 *
 * Long term: replace via `drizzle-kit pull` after `schema.sql` is applied (never hand-drift).
 * Column names match typical Blok cloud Postgres tables; extend as Go parity grows.
 */

import {
  bigint,
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: varchar('email', { length: 320 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: varchar('slug', { length: 128 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  role: varchar('role', { length: 32 }).notNull(),
});

export const pages = pgTable('pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  title: text('title').notNull(),
  parentId: uuid('parent_id'),
  trashed: boolean('trashed').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

/** Large counters (Go uses numeric(20,0) → string in pg). */
export const assets = pgTable('assets', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
  storageKey: text('storage_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});