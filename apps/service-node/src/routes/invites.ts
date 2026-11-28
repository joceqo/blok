import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';

import { findOrCreateUserByEmail } from '../auth/users.ts';
import { isValidEmail, normalizeEmail } from '../auth/codes.ts';
import type { DbVariables } from '../middleware/db.ts';
import type { SessionVariables } from '../middleware/session.ts';
import { requireUser } from '../middleware/require-user.ts';
import { requireWorkspaceRole } from '../http/workspace-access.ts';
import { users, workspaceInvites, workspaceMembers } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { parseWorkspaceRole } from '../workspaces/membership.ts';
import { validateInviteAccept } from '../workspaces/invite-accept.ts';
import { sendWorkspaceInviteEmail } from '../mail/smtp.ts';

type Env = { Variables: DbVariables & SessionVariables };

export const inviteRoutes = new Hono<Env>();

inviteRoutes.post('/api/workspaces/:id/invites', requireUser(), async (context) => {
  const workspaceId = context.req.param('id');
  const db = context.get('db');
  const invitedBy = context.get('userId');
  if (invitedBy === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  await requireWorkspaceRole(db, context, workspaceId, 'share');

  const body: { email?: string; role?: string } = await context.req
    .json<{ email?: string; role?: string }>()
    .catch(() => ({}));
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const role = typeof body.role === 'string' ? parseWorkspaceRole(body.role) : undefined;

  if (!isValidEmail(email) || role === undefined) {
    return context.json({ error: 'invalid_request' }, 400);
  }

  const pending = (
    await db
      .select({ id: workspaceInvites.id })
      .from(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.workspaceId, workspaceId),
          eq(workspaceInvites.email, email),
          isNull(workspaceInvites.acceptedAt),
        ),
      )
      .limit(1)
  )[0];
  if (pending !== undefined) {
    return context.json({ error: 'invite_pending' }, 409);
  }

  const inserted = await db
    .insert(workspaceInvites)
    .values({
      workspaceId,
      email,
      role,
      invitedBy,
    })
    .returning();

  const invite = inserted[0];
  if (invite === undefined) {
    return context.json({ error: 'invite_create_failed' }, 500);
  }

  void sendWorkspaceInviteEmail(email, invite.id, workspaceId).catch(() => {});

  return context.json(
    {
      invite: {
        id: invite.id,
        workspaceId: invite.workspaceId,
        email: invite.email,
        role: parseWorkspaceRole(invite.role) ?? invite.role,
        invitedBy: invite.invitedBy,
        createdAt: invite.createdAt,
        acceptedAt: invite.acceptedAt,
      },
    },
    201,
  );
});

inviteRoutes.get('/api/workspaces/:id/invites', requireUser(), async (context) => {
  const workspaceId = context.req.param('id');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'share');

  const rows = await db
    .select()
    .from(workspaceInvites)
    .where(
      and(eq(workspaceInvites.workspaceId, workspaceId), isNull(workspaceInvites.acceptedAt)),
    );

  return context.json({
    invites: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      email: row.email,
      role: parseWorkspaceRole(row.role) ?? row.role,
      invitedBy: row.invitedBy,
      createdAt: row.createdAt,
      acceptedAt: row.acceptedAt,
    })),
  });
});

inviteRoutes.get('/api/invites', requireUser(), async (context) => {
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (user === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const rows = await db
    .select()
    .from(workspaceInvites)
    .where(and(eq(workspaceInvites.email, user.email), isNull(workspaceInvites.acceptedAt)));

  return context.json({
    invites: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      email: row.email,
      role: parseWorkspaceRole(row.role) ?? row.role,
      invitedBy: row.invitedBy,
      createdAt: row.createdAt,
    })),
  });
});

inviteRoutes.delete('/api/workspaces/:id/invites/:inviteId', requireUser(), async (context) => {
  const workspaceId = context.req.param('id');
  const inviteId = context.req.param('inviteId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'share');

  const removed = await db
    .delete(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.id, inviteId),
        eq(workspaceInvites.workspaceId, workspaceId),
        isNull(workspaceInvites.acceptedAt),
      ),
    )
    .returning({ id: workspaceInvites.id });

  if (removed[0] === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ ok: true });
});

inviteRoutes.post('/api/invites/:id/accept', requireUser(), async (context) => {
  const inviteId = context.req.param('id');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const invite = (
    await db.select().from(workspaceInvites).where(eq(workspaceInvites.id, inviteId)).limit(1)
  )[0];
  if (invite === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (user === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const validation = validateInviteAccept(
    { acceptedAt: invite.acceptedAt, email: invite.email },
    user.email,
  );
  if (!validation.ok) {
    if (validation.reason === 'already_accepted') {
      return context.json({ error: 'already_accepted' }, 409);
    }
    return context.json({ error: 'email_mismatch' }, 403);
  }

  const role = parseWorkspaceRole(invite.role);
  if (role === undefined) {
    return context.json({ error: 'invalid_invite' }, 500);
  }

  try {
    await withTransaction(db, async (tx) => {
      const acceptedAt = new Date();
      const updated = await tx
        .update(workspaceInvites)
        .set({ acceptedAt })
        .where(
          and(eq(workspaceInvites.id, inviteId), isNull(workspaceInvites.acceptedAt)),
        )
        .returning({ id: workspaceInvites.id });

      if (updated[0] === undefined) {
        throw new Error('already_accepted');
      }

      await tx.insert(workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId,
        role,
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'already_accepted') {
      return context.json({ error: 'already_accepted' }, 409);
    }
    return context.json({ error: 'already_member' }, 409);
  }

  return context.json({ ok: true });
});