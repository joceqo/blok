import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DbVariables } from '../middleware/db.js';
import type { SessionVariables } from '../middleware/session.js';
import { requireUser } from '../middleware/require-user.js';
import { requireWorkspaceRole, roleInWorkspace } from '../http/workspace-access.js';
import { withTransaction } from '../db/transaction.js';
import { workspaces, workspaceMembers } from '../db/schema.js';
import {
  listWorkspacesForUser,
  memberRows,
  parseWorkspaceRole,
  memberRole,
} from '../workspaces/membership.js';
import { slugFromName } from '../workspaces/slug.js';
import { findOrCreateUserByEmail } from '../auth/users.js';
import { normalizeEmail, isValidEmail } from '../auth/codes.js';
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
  const slug =
    typeof body.slug === 'string' && body.slug.trim().length > 0
      ? body.slug.trim().toLowerCase()
      : slugFromName(name);

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

  const body: { name?: string } = await context.req.json<{ name?: string }>().catch(() => ({}));
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return context.json({ error: 'invalid_name' }, 400);
  }

  const updated = await db
    .update(workspaces)
    .set({ name: body.name.trim() })
    .where(eq(workspaces.id, workspaceId))
    .returning();

  const workspace = updated[0];
  if (workspace === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ workspace });
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