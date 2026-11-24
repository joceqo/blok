import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { calendarRange } from './calendar.ts';
import { sessionDigest } from './session.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';

type Busy = { start: string; end: string };
type FreeBusy = (workspace: string, user: string, from: string, to: string) => Promise<Busy[]>;

// Reveal only the union of occupied time within the requested window. Touching
// appointments become one block, so their individual boundaries stay private.
export function busyWithin(periods: Busy[], from: string, to: string): Busy[] {
  const lower = Date.parse(from), upper = Date.parse(to);
  const intervals = periods.map(period => {
    const start = Date.parse(period.start), end = Date.parse(period.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new HTTPException(503, { message: 'Disponibilités indisponibles.' });
    }
    return { start: Math.max(lower, start), end: Math.min(upper, end) };
  }).filter(period => period.start < period.end).sort((a, b) => a.start - b.start);
  const merged: typeof intervals = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && last.end >= interval.start) last.end = Math.max(last.end, interval.end);
    else merged.push(interval);
  }
  return merged.map(({ start, end }) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() }));
}

export function calendarSharing(pool: PgPool, freeBusy: FreeBusy) {
  const router = new Hono();
  router.get('/members', async c => {
    c.header('Cache-Control', 'private, no-store');
    const result = await inTransaction(pool, async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const actor = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, false);
      const { rows } = await db.query<{id: string; name: string}>(
        `SELECT u.id,coalesce(nullif(u.name,''),'Membre') AS name
         FROM calendar_availability_shares s JOIN users u ON u.id=s.user_id
         WHERE s.workspace_id=$1 ORDER BY name,u.id`, [actor.workspace_id]);
      return { sharing: rows.some(item => item.id === actor.user_id), members: rows.filter(item => item.id !== actor.user_id) };
    });
    return c.json(result);
  });

  router.put('/sharing', bodyLimit({ maxSize: 1024 }), async c => {
    c.header('Cache-Control', 'private, no-store');
    const input = await c.req.json().catch(() => null);
    if (typeof input?.enabled !== 'boolean' || Object.keys(input).length !== 1) {
      throw new WorkspaceError(400, 'Préférence de partage invalide.');
    }
    await inTransaction(pool, async db => {
      const actor = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, true);
      const owner = [actor.workspace_id, actor.user_id];
      if (input.enabled) {
        await db.query('INSERT INTO calendar_availability_shares(workspace_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', owner);
      } else {
        await db.query('DELETE FROM calendar_availability_shares WHERE workspace_id=$1 AND user_id=$2', owner);
      }
    });
    return c.json({ sharing: input.enabled });
  });

  router.get('/members/:userId/freebusy', async c => {
    c.header('Cache-Control', 'private, no-store');
    const { from, to } = calendarRange(c.req.query());
    if (Date.parse(to) - Date.parse(from) > 31 * 86400000) throw new WorkspaceError(400, 'La période est limitée à 31 jours.');
    const user = c.req.param('userId');
    const authorize = () => inTransaction(pool, async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const actor = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, false);
      const shared = await db.query('SELECT 1 FROM calendar_availability_shares WHERE workspace_id=$1 AND user_id=$2', [actor.workspace_id, user]);
      if (!shared.rowCount || actor.user_id === user) throw new WorkspaceError(404, 'Disponibilités introuvables.');
      return actor.workspace_id;
    });
    const workspace = await authorize();
    let periods: Busy[];
    try { periods = await freeBusy(workspace, user, from, to); }
    catch { throw new HTTPException(503, { message: 'Disponibilités indisponibles.' }); }
    // The provider call runs outside PostgreSQL. A revocation, logout or member
    // departure during that call must take effect before any periods are returned.
    if (await authorize() !== workspace) throw new WorkspaceError(404, 'Disponibilités introuvables.');
    return c.json({ busy: busyWithin(periods, from, to) });
  });
  return router;
}
