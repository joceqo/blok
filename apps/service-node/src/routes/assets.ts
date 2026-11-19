import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { assets } from '../db/schema.js';
import { requireWorkspaceRole } from '../http/workspace-access.js';
import type { DbVariables } from '../middleware/db.js';
import { requireUser } from '../middleware/require-user.js';
import type { SessionVariables } from '../middleware/session.js';

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

  return context.json(
    {
      asset: {
        id: asset.id,
        workspaceId: asset.workspaceId,
        storageKey: asset.storageKey,
        byteSize: asset.byteSize.toString(),
        createdAt: asset.createdAt,
      },
    },
    201,
  );
});