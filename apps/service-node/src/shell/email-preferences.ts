import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { sessionDigest } from './session.ts';
import { readWorkspaceSession } from './workspace-scope.ts';

export interface EmailPreferences {
  activity: boolean;
  always: boolean;
  pageUpdates: boolean;
  digest: boolean;
  calendarInvites: boolean;
  calendarResponses: boolean;
}

/** Setting name to its column; the only names a request may touch. */
const columnOf = {
  activity: 'activity',
  always: 'always',
  pageUpdates: 'page_updates',
  digest: 'digest',
  calendarInvites: 'calendar_invites',
  calendarResponses: 'calendar_responses',
} as const;

interface StoredRow { activity: boolean; always: boolean; page_updates: boolean; digest: boolean; calendar_invites: boolean; calendar_responses: boolean }

/** No row means nobody asked: every setting reads as off. */
export function emailPreferenceRows(row: StoredRow | undefined): EmailPreferences {
  return {
    activity: row?.activity === true,
    always: row?.always === true,
    pageUpdates: row?.page_updates === true,
    digest: row?.digest === true,
    calendarInvites: row?.calendar_invites === true,
    calendarResponses: row?.calendar_responses === true,
  };
}

/**
 * The columns and values a write may set. Unknown names are dropped and
 * anything that is not `true` becomes false: a malformed body must never
 * turn mail on.
 */
export function emailPreferenceWrite(body: Partial<EmailPreferences>) {
  const columns: string[] = [];
  const values: boolean[] = [];
  for (const [name, column] of Object.entries(columnOf)) {
    if (!(name in body)) continue;
    columns.push(column);
    values.push(body[name as keyof EmailPreferences] === true);
  }
  return { columns, values };
}

export function emailPreferences(pool: PgPool) {
  const router = new Hono();

  router.get('/', async (c) => {
    const result = await inTransaction(pool, async (db) => {
      const { workspace_id, user_id } = await readWorkspaceSession(db, sessionDigest(c) ?? '', c.req.param('slug')!, false);
      const { rows: [row] } = await db.query<StoredRow>(
        'SELECT activity,always,page_updates,digest,calendar_invites,calendar_responses FROM email_notification_preferences WHERE workspace_id=$1 AND user_id=$2',
        [workspace_id, user_id],
      );
      return emailPreferenceRows(row);
    });
    return c.json(result);
  });

  router.put('/', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== 'object') throw new HTTPException(400, { message: 'Invalid body' });
    const { columns, values } = emailPreferenceWrite(body as Partial<EmailPreferences>);
    if (columns.length === 0) throw new HTTPException(400, { message: 'No known setting' });
    const result = await inTransaction(pool, async (db) => {
      const { workspace_id, user_id } = await readWorkspaceSession(db, sessionDigest(c) ?? '', c.req.param('slug')!, true);
      const placeholders = columns.map((_, index) => `$${index + 3}`);
      const assignments = columns.map((column, index) => `${column}=$${index + 3}`);
      const { rows: [row] } = await db.query<StoredRow>(
        `INSERT INTO email_notification_preferences(workspace_id,user_id,${columns.join(',')})
         VALUES($1,$2,${placeholders.join(',')})
         ON CONFLICT (workspace_id,user_id) DO UPDATE SET ${assignments.join(',')}
         RETURNING activity,always,page_updates,digest,calendar_invites,calendar_responses`,
        [workspace_id, user_id, ...values],
      );
      return emailPreferenceRows(row);
    });
    return c.json(result);
  });

  return router;
}
