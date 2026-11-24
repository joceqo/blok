import { and, eq } from 'drizzle-orm';

import { pages } from '@/db/schema.js';
import type { Database } from '@/db/index.js';

type PageRow = typeof pages.$inferSelect;
import { wouldCreatePageCycle } from '@/pages/tree.js';

export type PageReparentFailure = 'not_found' | 'invalid_parent' | 'cycle';

export type PageReparentResult =
  | { ok: true; page: PageRow }
  | { ok: false; reason: PageReparentFailure };

export async function reparentPage(
  db: Database,
  pageId: string,
  workspaceId: string,
  parentId: string | null,
): Promise<PageReparentResult> {
  const existing = (await db.select().from(pages).where(eq(pages.id, pageId)).limit(1))[0];
  if (existing === undefined || existing.workspaceId !== workspaceId) {
    return { ok: false, reason: 'not_found' };
  }

  if (parentId !== null) {
    const parent = (
      await db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.id, parentId), eq(pages.workspaceId, workspaceId)))
        .limit(1)
    )[0];
    if (parent === undefined) {
      return { ok: false, reason: 'invalid_parent' };
    }
  }

  const workspacePages = await db
    .select({ id: pages.id, parentId: pages.parentId })
    .from(pages)
    .where(eq(pages.workspaceId, workspaceId));

  if (wouldCreatePageCycle(pageId, parentId, workspacePages)) {
    return { ok: false, reason: 'cycle' };
  }

  const updated = await db
    .update(pages)
    .set({ parentId, updatedAt: new Date() })
    .where(eq(pages.id, pageId))
    .returning();
  const page = updated[0];
  if (page === undefined) {
    return { ok: false, reason: 'not_found' };
  }

  return { ok: true, page };
}