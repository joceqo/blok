import { eq } from 'drizzle-orm';

import type { Database } from '../db/index.ts';
import { workspaces } from '../db/schema.ts';

import { type WorkspaceSlugValidation } from './slug.ts';

export type WorkspaceSlugAvailability =
  | { status: 'invalid'; reason: 'invalid_slug' | 'slug_too_short' | 'slug_too_long' }
  | { status: 'ok'; available: boolean };

/** Pure availability from validation + uniqueness (no membership). */
export function resolveWorkspaceSlugAvailability(
  validation: WorkspaceSlugValidation,
  slugTaken: boolean,
): WorkspaceSlugAvailability {
  if (!validation.ok) {
    return { status: 'invalid', reason: validation.reason };
  }
  return { status: 'ok', available: !slugTaken };
}

export async function workspaceSlugIsTaken(db: Database, slug: string): Promise<boolean> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return rows[0] !== undefined;
}