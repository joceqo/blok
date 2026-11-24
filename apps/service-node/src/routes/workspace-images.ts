import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { workspaceImages } from '@/db/schema.js';
import { requireWorkspaceRole } from '@/http/workspace-access.js';
import type { DbVariables } from '@/middleware/db.js';
import { requireUser } from '@/middleware/require-user.js';
import type { SessionVariables } from '@/middleware/session.js';
import { toWorkspaceImageJson } from '@/workspace-images/serialize.js';

type Env = { Variables: DbVariables & SessionVariables };

export const workspaceImageRoutes = new Hono<Env>();

workspaceImageRoutes.get('/api/workspaces/:workspaceId/images', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'read');

  const rows = await db
    .select({
      id: workspaceImages.id,
      byteSize: workspaceImages.byteSize,
      storageKey: workspaceImages.storageKey,
      createdAt: workspaceImages.createdAt,
    })
    .from(workspaceImages)
    .where(eq(workspaceImages.workspaceId, workspaceId))
    .orderBy(asc(workspaceImages.createdAt));

  return context.json({
    images: rows.map((row) => ({
      ...row,
      byteSize: row.byteSize.toString(),
    })),
  });
});

workspaceImageRoutes.post('/api/workspaces/:workspaceId/images', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'edit');

  const body: { storageKey?: string; byteSize?: string | number } = await context.req
    .json<{ storageKey?: string; byteSize?: string | number }>()
    .catch(() => ({}));

  const storageKey = typeof body.storageKey === 'string' ? body.storageKey.trim() : '';
  if (storageKey.length === 0) {
    return context.json({ error: 'invalid_storage_key' }, 400);
  }

  let byteSize = 0n;
  if (typeof body.byteSize === 'number' && Number.isInteger(body.byteSize) && body.byteSize >= 0) {
    byteSize = BigInt(body.byteSize);
  } else if (typeof body.byteSize === 'string' && /^\d+$/.test(body.byteSize)) {
    byteSize = BigInt(body.byteSize);
  } else {
    return context.json({ error: 'invalid_byte_size' }, 400);
  }

  const inserted = await db
    .insert(workspaceImages)
    .values({
      workspaceId,
      storageKey,
      byteSize,
    })
    .returning();

  const image = inserted[0];
  if (image === undefined) {
    return context.json({ error: 'insert_failed' }, 500);
  }

  return context.json({ image: toWorkspaceImageJson(image) }, 201);
});