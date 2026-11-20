import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Database } from '@/db/index.js';
import type { DbVariables } from '@/middleware/db.js';
import type { SessionVariables } from '@/middleware/session.js';
import { requireUser } from '@/middleware/require-user.js';
import { requireWorkspaceRole } from '@/http/workspace-access.js';
import {
  teamspaceMembers,
  teamspaces,
  users,
  workspaceMembers,
} from '@/db/schema.js';
import {
  parseTeamspaceCreateBody,
  parseTeamspaceMemberAddBody,
  serializeTeamspace,
} from '@/workspaces/teamspace-body.js';

type Env = { Variables: DbVariables & SessionVariables };

export const teamspaceRoutes = new Hono<Env>();

async function loadTeamspaceInWorkspace(
  db: Database,
  workspaceId: string,
  teamspaceId: string,
) {
  return (
    await db
      .select()
      .from(teamspaces)
      .where(and(eq(teamspaces.id, teamspaceId), eq(teamspaces.workspaceId, workspaceId)))
      .limit(1)
  )[0];
}

teamspaceRoutes.get('/api/workspaces/:workspaceId/teamspaces', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'read');

  const rows = await db
    .select()
    .from(teamspaces)
    .where(eq(teamspaces.workspaceId, workspaceId))
    .orderBy(asc(teamspaces.createdAt));

  return context.json({
    teamspaces: rows.map((row) => serializeTeamspace(row)),
  });
});

teamspaceRoutes.post('/api/workspaces/:workspaceId/teamspaces', requireUser(), async (context) => {
  const workspaceId = context.req.param('workspaceId');
  const db = context.get('db');

  await requireWorkspaceRole(db, context, workspaceId, 'edit');

  const raw: unknown = await context.req.json().catch(() => ({}));
  const parsed = parseTeamspaceCreateBody(raw);
  if (!parsed.ok) {
    return context.json({ error: parsed.reason }, 400);
  }

  const inserted = await db
    .insert(teamspaces)
    .values({
      workspaceId,
      name: parsed.name,
    })
    .returning();

  const teamspace = inserted[0];
  if (teamspace === undefined) {
    return context.json({ error: 'insert_failed' }, 500);
  }

  return context.json({ teamspace: serializeTeamspace(teamspace) }, 201);
});

teamspaceRoutes.get(
  '/api/workspaces/:workspaceId/teamspaces/:teamspaceId/members',
  requireUser(),
  async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const teamspaceId = context.req.param('teamspaceId');
    const db = context.get('db');

    await requireWorkspaceRole(db, context, workspaceId, 'read');

    const teamspace = await loadTeamspaceInWorkspace(db, workspaceId, teamspaceId);
    if (teamspace === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    const rows = await db
      .select({
        userId: teamspaceMembers.userId,
        email: users.email,
      })
      .from(teamspaceMembers)
      .innerJoin(users, eq(teamspaceMembers.userId, users.id))
      .where(eq(teamspaceMembers.teamspaceId, teamspaceId))
      .orderBy(asc(users.email));

    return context.json({
      members: rows.map((row) => ({
        userId: row.userId,
        email: row.email,
      })),
    });
  },
);

teamspaceRoutes.post(
  '/api/workspaces/:workspaceId/teamspaces/:teamspaceId/members',
  requireUser(),
  async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const teamspaceId = context.req.param('teamspaceId');
    const db = context.get('db');

    await requireWorkspaceRole(db, context, workspaceId, 'edit');

    const teamspace = await loadTeamspaceInWorkspace(db, workspaceId, teamspaceId);
    if (teamspace === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }

    const raw: unknown = await context.req.json().catch(() => ({}));
    const parsed = parseTeamspaceMemberAddBody(raw);
    if (!parsed.ok) {
      return context.json({ error: parsed.reason }, 400);
    }

    const workspaceMember = (
      await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, parsed.userId),
          ),
        )
        .limit(1)
    )[0];
    if (workspaceMember === undefined) {
      return context.json({ error: 'not_workspace_member' }, 400);
    }

    try {
      await db.insert(teamspaceMembers).values({
        teamspaceId,
        userId: parsed.userId,
      });
    } catch {
      return context.json({ error: 'already_member' }, 409);
    }

    const user = (
      await db.select({ email: users.email }).from(users).where(eq(users.id, parsed.userId)).limit(1)
    )[0];
    if (user === undefined) {
      return context.json({ error: 'user_not_found' }, 500);
    }

    return context.json(
      {
        member: {
          userId: parsed.userId,
          email: user.email,
        },
      },
      201,
    );
  },
);