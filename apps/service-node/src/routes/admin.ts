import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm';
import { Hono } from 'hono';

import { serializeAuditEvent } from '@/audit/serialize-audit-event.js';
import { auditEvents, users, workspaces } from '@/db/schema.js';
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  parseListPagination,
} from '@/http/pagination.js';
import { requireAdmin } from '@/middleware/admin.js';
import type { DbVariables } from '@/middleware/db.js';
import { requireUser } from '@/middleware/require-user.js';
import type { SessionVariables } from '@/middleware/session.js';

type Env = { Variables: DbVariables & SessionVariables };

const ADMIN_AUDIT_DEFAULT_LIMIT = 50;

/**
 * Admin routes — mirror Go flat style: `GET /api/admin/users/{id}`.
 * Restrict with `ADMIN_USER_IDS` (comma-separated user uuids) when set.
 */
export const adminRoutes = new Hono<Env>();

adminRoutes.use('/api/admin/*', requireUser(), requireAdmin());

adminRoutes.get('/api/admin/users/:id', async (context) => {
  const id = context.req.param('id');
  const db = context.get('db');

  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const user = rows[0];
  if (user === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ user: { id: user.id, email: user.email, createdAt: user.createdAt } });
});

adminRoutes.get('/api/admin/users', async (context) => {
  const db = context.get('db');
  const pagination = parseListPagination(context.req.query());

  const baseSelect = db
    .select({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users);

  if (!pagination.paginated) {
    const rows = await baseSelect.orderBy(asc(users.createdAt), asc(users.id));
    return context.json({ users: rows });
  }

  let cursorFilter: ReturnType<typeof and> | undefined;
  if (pagination.cursor !== undefined) {
    let decoded: { at: Date; id: string };
    try {
      decoded = decodeTimeIdCursor(pagination.cursor);
    } catch {
      return context.json({ error: 'invalid_cursor' }, 400);
    }
    cursorFilter = or(
      gt(users.createdAt, decoded.at),
      and(eq(users.createdAt, decoded.at), gt(users.id, decoded.id)),
    );
  }

  const paged = cursorFilter !== undefined ? baseSelect.where(cursorFilter) : baseSelect;
  const rows = await paged.orderBy(asc(users.createdAt), asc(users.id)).limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const usersPage = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = usersPage.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeTimeIdCursor(last.createdAt, last.id)
      : undefined;

  return context.json({
    users: usersPage,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
});

adminRoutes.get('/api/admin/workspaces', async (context) => {
  const db = context.get('db');
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt));

  return context.json({ workspaces: rows });
});

adminRoutes.get('/api/admin/audit', async (context) => {
  const db = context.get('db');
  const pagination = parseListPagination(context.req.query(), ADMIN_AUDIT_DEFAULT_LIMIT);

  const baseSelect = db
    .select({
      id: auditEvents.id,
      workspaceId: auditEvents.workspaceId,
      userId: auditEvents.userId,
      action: auditEvents.action,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents);

  if (!pagination.paginated) {
    const rows = await baseSelect.orderBy(desc(auditEvents.createdAt), desc(auditEvents.id));
    return context.json({ events: rows.map((row) => serializeAuditEvent(row)) });
  }

  let cursorFilter: ReturnType<typeof and> | undefined;
  if (pagination.cursor !== undefined) {
    let decoded: { at: Date; id: string };
    try {
      decoded = decodeTimeIdCursor(pagination.cursor);
    } catch {
      return context.json({ error: 'invalid_cursor' }, 400);
    }
    cursorFilter = or(
      lt(auditEvents.createdAt, decoded.at),
      and(eq(auditEvents.createdAt, decoded.at), lt(auditEvents.id, decoded.id)),
    );
  }

  const paged = cursorFilter !== undefined ? baseSelect.where(cursorFilter) : baseSelect;
  const rows = await paged
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const eventsPage = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = eventsPage.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeTimeIdCursor(last.createdAt, last.id)
      : undefined;

  return context.json({
    events: eventsPage.map((row) => serializeAuditEvent(row)),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
});