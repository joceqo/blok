import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { toAssetJson } from '../assets/serialize.ts';
import { assets } from '../db/schema.ts';
import { requireWorkspaceRole } from '../http/workspace-access.ts';
import type { DbVariables } from '../middleware/db.ts';
import { requireUser } from '../middleware/require-user.ts';
import type { SessionVariables } from '../middleware/session.ts';

type Env = { Variables: DbVariables & SessionVariables };

export const assetRoutes = new Hono<Env>();

assetRoutes.get('/api/workspaces/:workspaceId/assets', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'read');

  const rows = await db
    .select({
      id: assets.id,
      byteSize: assets.byteSize,
      storageKey: assets.storageKey,
      createdAt: assets.createdAt,
    })
    .from(assets)
    .where(eq(assets.workspaceId, workspaceId))
    .orderBy(asc(assets.createdAt));

  return context.json({
    assets: rows.map((row) => ({
      ...row,
      byteSize: row.byteSize.toString(),
    })),
  });
});

assetRoutes.post('/api/workspaces/:workspaceId/assets', requireUser(), async (context) => {
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
    .insert(assets)
    .values({
      workspaceId,
      storageKey,
      byteSize,
    })
    .returning();

  const asset = inserted[0];
  if (asset === undefined) {
    return context.json({ error: 'insert_failed' }, 500);
  }

  return context.json({ asset: toAssetJson(asset) }, 201);
});

assetRoutes.get(
  '/api/workspaces/:workspaceId/assets/:assetId',
  requireUser(),
  async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const assetId = context.req.param('assetId');
    const db = context.get('db');

    await requireWorkspaceRole(db, context, workspaceId, 'read');

    const row = (
      await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)))
        .limit(1)
    )[0];
    if (row === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    return context.json({ asset: toAssetJson(row) });
  },
);

assetRoutes.delete(
  '/api/workspaces/:workspaceId/assets/:assetId',
  requireUser(),
  async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const assetId = context.req.param('assetId');
    const db = context.get('db');

    await requireWorkspaceRole(db, context, workspaceId, 'edit');

    const removed = await db
      .delete(assets)
      .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)))
      .returning({ id: assets.id });

    if (removed[0] === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    return context.json({ ok: true });
  },
);