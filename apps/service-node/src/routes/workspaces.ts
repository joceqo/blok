import { and, asc, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DbVariables } from '@/middleware/db.js';
import type { SessionVariables } from '@/middleware/session.js';
import { requireUser } from '@/middleware/require-user.js';
import { requireWorkspaceRole, roleInWorkspace } from '@/http/workspace-access.js';
import { withTransaction } from '@/db/transaction.js';
import {
  pages,
  workspaces,
  workspaceInvites,
  workspaceMembers,
  workspacePresets,
} from '@/db/schema.js';
import {
  listWorkspacesForUser,
  memberRows,
  parseWorkspaceRole,
  memberRole,
} from '@/workspaces/membership.js';
import { canDeleteWorkspace } from '@/workspaces/can-delete-workspace.js';
import { validateMemberRoleChange } from '@/workspaces/member-role-change.js';
import { validateOwnershipTransfer } from '@/workspaces/ownership-transfer.js';
import { parsePresetConfig } from '@/workspaces/preset-config.js';
import { slugFromName, validateWorkspaceSlug } from '@/workspaces/slug.js';
import { findOrCreateUserByEmail } from '@/auth/users.js';
import { normalizeEmail, isValidEmail } from '@/auth/codes.js';
type Env = { Variables: DbVariables & SessionVariables };

export const workspaceRoutes = new Hono<Env>();

workspaceRoutes.post('/api/workspaces', requireUser(), async (context) => {
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const body: { name?: string; slug?: string } = await context.req
    .json<{ name?: string; slug?: string }>()
    .catch(() => ({}));
  const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : 'Workspace';
  let slug: string;
  if (typeof body.slug === 'string' && body.slug.trim().length > 0) {
    const validation = validateWorkspaceSlug(body.slug);
    if (!validation.ok) {
      return context.json({ error: validation.reason }, 400);
    }
    slug = validation.slug;
  } else {
    slug = slugFromName(name);
  }

  const db = context.get('db');
  try {
    const created = await withTransaction(db, async (tx) => {
      const inserted = await tx.insert(workspaces).values({ name, slug }).returning();
      const workspace = inserted[0];
      if (workspace === undefined) {
        throw new Error('insert_failed');
      }
      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId,
        role: 'owner',
      });
      return workspace;
    });
    return context.json({ workspace: created }, 201);
  } catch {
    return context.json({ error: 'slug_taken_or_failed' }, 409);
  }
});

workspaceRoutes.get('/api/workspaces', requireUser(), async (context) => {
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }
  const db = context.get('db');
  const rows = await listWorkspacesForUser(db, userId);
  return context.json({ workspaces: rows });
});

workspaceRoutes.get('/api/workspaces/by-slug/:slug', requireUser(), async (context) => {
  const slug = context.req.param('slug');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const db = context.get('db');
  const rows = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  const workspace = rows[0];
  if (workspace === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const role = await memberRole(db, userId, workspace.id);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ workspace: { ...workspace, role } });
});

workspaceRoutes.get('/api/workspaces/:workspaceId', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const db = context.get('db');
  const role = await memberRole(db, userId, workspaceId);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const rows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const workspace = rows[0];
  if (workspace === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ workspace: { ...workspace, role } });
});

workspaceRoutes.patch('/api/workspaces/:workspaceId', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'share');

  const body: { name?: string; slug?: string } = await context.req
    .json<{ name?: string; slug?: string }>()
    .catch(() => ({}));

  const updates: { name?: string; slug?: string } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return context.json({ error: 'invalid_name' }, 400);
    }
    updates.name = body.name.trim();
  }
  if (body.slug !== undefined) {
    if (typeof body.slug !== 'string') {
      return context.json({ error: 'invalid_slug' }, 400);
    }
    const validation = validateWorkspaceSlug(body.slug);
    if (!validation.ok) {
      return context.json({ error: validation.reason }, 400);
    }
    updates.slug = validation.slug;
  }
  if (updates.name === undefined && updates.slug === undefined) {
    return context.json({ error: 'invalid_request' }, 400);
  }

  try {
    const updated = await db
      .update(workspaces)
      .set(updates)
      .where(eq(workspaces.id, workspaceId))
      .returning();

    const workspace = updated[0];
    if (workspace === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    return context.json({ workspace });
  } catch {
    return context.json({ error: 'slug_taken_or_failed' }, 409);
  }
});

workspaceRoutes.delete('/api/workspaces/:workspaceId', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  const actorRole = await requireWorkspaceRole(db, context, workspaceId, 'delete');

  const countRow = (
    await db
      .select({ value: count() })
      .from(pages)
      .where(eq(pages.workspaceId, workspaceId))
  )[0];
  const pageCount = Number(countRow?.value ?? 0);

  const validation = canDeleteWorkspace({ actorRole, pageCount });
  if (!validation.ok) {
    if (validation.reason === 'has_content') {
      return context.json({ error: 'has_content' }, 409);
    }
    return context.json({ error: 'permission_denied' }, 403);
  }

  await withTransaction(db, async (tx) => {
    await tx.delete(workspaceInvites).where(eq(workspaceInvites.workspaceId, workspaceId));
    await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  return context.json({ ok: true });
});

workspaceRoutes.get('/api/workspaces/:workspaceId/members', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'read');

  const members = await memberRows(db, workspaceId);
  return context.json({
    members: members.map((row) => ({
      userId: row.userId,
      email: row.email,
      role: parseWorkspaceRole(row.role) ?? row.role,
    })),
  });
});

workspaceRoutes.post('/api/workspaces/:workspaceId/members', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'share');

  const body: { email?: string; role?: string } = await context.req
    .json<{ email?: string; role?: string }>()
    .catch(() => ({}));
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const role = typeof body.role === 'string' ? parseWorkspaceRole(body.role) : undefined;

  if (!isValidEmail(email) || role === undefined) {
    return context.json({ error: 'invalid_request' }, 400);
  }

  const invited = await findOrCreateUserByEmail(db, email);
  if (invited === undefined) {
    return context.json({ error: 'user_create_failed' }, 500);
  }

  try {
    await db.insert(workspaceMembers).values({
      workspaceId,
      userId: invited.id,
      role,
    });
  } catch {
    return context.json({ error: 'already_member' }, 409);
  }

  return context.json({ ok: true }, 201);
});

workspaceRoutes.patch(
  '/api/workspaces/:workspaceId/members/:userId',
  requireUser(),
  async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const targetUserId = context.req.param('userId');
    const db = context.get('db');

    const actorRole = await requireWorkspaceRole(db, context, workspaceId, 'share');

    const body: { role?: string } = await context.req.json<{ role?: string }>().catch(() => ({}));
    const nextRole = typeof body.role === 'string' ? parseWorkspaceRole(body.role) : undefined;
    if (nextRole === undefined) {
      return context.json({ error: 'invalid_request' }, 400);
    }

    const targetRole = await memberRole(db, targetUserId, workspaceId);
    if (targetRole === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    const ownerRows = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')),
      );
    const ownerCount = ownerRows.length;

    const validation = validateMemberRoleChange({
      actorRole,
      targetRole,
      nextRole,
      ownerCount,
    });
    if (!validation.ok) {
      return context.json({ error: validation.reason }, 403);
    }

    const updated = await db
      .update(workspaceMembers)
      .set({ role: nextRole })
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)),
      )
      .returning();

    if (updated[0] === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    return context.json({ ok: true, role: nextRole });
  },
);

workspaceRoutes.post(
  '/api/workspaces/:workspaceId/transfer-ownership',
  requireUser(),
  async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const db = context.get('db');
    const actorId = context.get('userId');
    if (actorId === undefined) {
      return context.json({ error: 'unauthenticated' }, 401);
    }

    const actorRole = await requireWorkspaceRole(db, context, workspaceId, 'share');

    const body: { userId?: string } = await context.req
      .json<{ userId?: string }>()
      .catch(() => ({}));
    const targetUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
    if (targetUserId.length === 0) {
      return context.json({ error: 'invalid_request' }, 400);
    }

    const targetRole = await memberRole(db, targetUserId, workspaceId);
    if (targetRole === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    const validation = validateOwnershipTransfer({
      actorRole,
      targetRole,
      actorUserId: actorId,
      targetUserId,
    });
    if (!validation.ok) {
      return context.json({ error: validation.reason }, 403);
    }

    await withTransaction(db, async (tx) => {
      await tx
        .update(workspaceMembers)
        .set({ role: 'owner' })
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)),
        );
      await tx
        .update(workspaceMembers)
        .set({ role: 'admin' })
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)),
        );
    });

    return context.json({ ok: true });
  },
);

workspaceRoutes.get('/api/workspaces/:workspaceId/presets', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'read');

  const rows = await db
    .select()
    .from(workspacePresets)
    .where(eq(workspacePresets.workspaceId, workspaceId))
    .orderBy(asc(workspacePresets.createdAt));

  return context.json({
    presets: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      config: row.config,
      createdAt: row.createdAt,
    })),
  });
});

workspaceRoutes.post('/api/workspaces/:workspaceId/presets', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'edit');

  const body: { name?: string; config?: unknown } = await context.req
    .json<{ name?: string; config?: unknown }>()
    .catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0) {
    return context.json({ error: 'invalid_request' }, 400);
  }

  const parsed = parsePresetConfig(body.config);
  if (!parsed.ok) {
    return context.json({ error: parsed.reason }, 400);
  }

  const inserted = await db
    .insert(workspacePresets)
    .values({
      workspaceId,
      name,
      config: parsed.config,
    })
    .returning();

  const preset = inserted[0];
  if (preset === undefined) {
    return context.json({ error: 'insert_failed' }, 500);
  }

  return context.json(
    {
      preset: {
        id: preset.id,
        workspaceId: preset.workspaceId,
        name: preset.name,
        config: preset.config,
        createdAt: preset.createdAt,
      },
    },
    201,
  );
});

workspaceRoutes.delete(
  '/api/workspaces/:workspaceId/members/:userId',
  requireUser(),
  async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const targetUserId = context.req.param('userId');
    const db = context.get('db');
    const actorId = context.get('userId');

    const actorRole = await requireWorkspaceRole(db, context, workspaceId, 'share');

    const targetRole = await memberRole(db, targetUserId, workspaceId);
    if (targetRole === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    if (targetRole === 'owner' && actorId !== targetUserId) {
      return context.json({ error: 'cannot_remove_owner' }, 403);
    }

    if (actorRole !== 'owner' && actorRole !== 'admin') {
      return context.json({ error: 'permission_denied' }, 403);
    }

    await db
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)),
      );

    return context.json({ ok: true });
  },
);