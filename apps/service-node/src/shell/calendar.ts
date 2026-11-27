import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';
import { recordCalendarResponse, validCalendarResponse } from './calendar-response.ts';
import { deliverNotificationMails, type Notice } from './notification-mail.ts';
import { inTransaction } from './bootstrap.ts';
import { sessionDigest } from './session.ts';
import { loadIndexPages, pageStandings } from './workspace-index.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const day = /^\d{4}-\d{2}-\d{2}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const notFound = () => new WorkspaceError(404, 'Événement ou page introuvable.');
const conflict = () => new WorkspaceError(409, 'Cet événement a changé. Rechargez le calendrier.');

function timestamp(raw: unknown, allDay: boolean): string {
  if (typeof raw !== 'string' || !(allDay ? day : instant).test(raw) || raw.startsWith('0000')) {
    throw new WorkspaceError(400, 'Date du calendrier invalide.');
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw.slice(0, 10)) {
    throw new WorkspaceError(400, 'Date du calendrier invalide.');
  }
  return date.toISOString();
}

export function calendarRange(query: Record<string, string>) {
  const from = timestamp(query.from, false);
  const to = timestamp(query.to, false);
  const local = query.fromDate !== undefined || query.toDate !== undefined;
  // Floating dates are encoded at UTC midnight, independently of the device zone.
  const fromDay = local ? timestamp(query.fromDate, true) : timestamp(from.slice(0, 10), true);
  const endOfDay = timestamp(to.slice(0, 10), true);
  const toDay = local ? timestamp(query.toDate, true) : to === endOfDay ? endOfDay : new Date(Date.parse(endOfDay) + 86400000).toISOString();
  if (to <= from || toDay <= fromDay) throw new WorkspaceError(400, 'Période du calendrier invalide.');
  return { from, to, fromDay, toDay };
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2147483647;
}

export function calendarInput(id: string, raw: unknown) {
  const event = raw as Record<string, unknown> | null;
  if (!event || !uuid.test(id) || event.id !== id || typeof event.title !== 'string' ||
      !event.title.trim() || [...event.title.trim()].length > 300 || event.title.includes('\0') ||
      typeof event.allDay !== 'boolean' || !isRevision(event.revision) ||
      (event.pageId !== null && (typeof event.pageId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.pageId)))) {
    throw new WorkspaceError(400, 'Événement du calendrier invalide.');
  }
  const start = timestamp(event.start, event.allDay);
  const end = timestamp(event.end, event.allDay);
  if (end <= start) throw new WorkspaceError(400, 'La fin doit suivre le début.');
  const participants = event.participantIds;
  if (participants !== undefined && (!Array.isArray(participants) || participants.length > 64 ||
      participants.some(id => typeof id !== 'string' || !id || id.length > 128 || id.includes('\0')))) {
    throw new WorkspaceError(400, 'Liste des participants invalide.');
  }
  const participantIds = participants === undefined ? undefined : [...new Set(participants as string[])];
  return { participantIds, id, title: event.title.trim(), start, end, allDay: event.allDay, pageId: event.pageId, revision: event.revision };
}

type Scope = Awaited<ReturnType<typeof readWorkspaceScope>>;
type Row = { organizer_id:string | null; detached_private:boolean; participant_ids?: string[]; participant_responses?: Record<string,string> | null; id: string; title: string; starts_at: Date; ends_at: Date; all_day: boolean; page_id: string | null; revision: number };
const columns = 'id,title,starts_at,ends_at,all_day,page_id,revision,organizer_id,detached_private';

function eventData(row: Row) {
  const format = (date: Date) => row.all_day ? date.toISOString().slice(0, 10) : date.toISOString();
  return { id: row.id, title: row.title, start: format(row.starts_at), end: format(row.ends_at),
    ...(row.participant_ids?.length && {participantIds: row.participant_ids}),
    ...(row.participant_responses && {participantResponses: row.participant_responses}),
    allDay: row.all_day, pageId: row.page_id, revision: row.revision };
}

async function visiblePages(db: PoolClient, scope: Scope) {
  const pages = await loadIndexPages(db, scope.workspace_id, scope.user_id);
  const access = pageStandings(pages, scope.role);
  return new Set(pages.filter(page => !page.trashed && access[page.id]).map(page => page.id));
}

export function workspaceCalendar(pool: PgPool) {
  const router = new Hono();
  router.patch('/preferences', bodyLimit({maxSize: 1024}), async c => {
    const patch = await c.req.json().catch(() => null);
    if (!patch || typeof patch.accountId !== 'string' ||
        (patch.connected === undefined && patch.visible === undefined) ||
        (patch.connected !== undefined && typeof patch.connected !== 'boolean') ||
        (patch.visible !== undefined && typeof patch.visible !== 'boolean')) {
      throw new WorkspaceError(400, 'Préférences de calendrier invalides.');
    }
    await inTransaction(pool, async db => {
      const scope = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, true);
      if (scope.user_id !== patch.accountId) throw new WorkspaceError(403, 'Le compte de cet agenda a changé.');
      await db.query(`INSERT INTO calendar_workspace_preferences(workspace_id,user_id,connected,visible)
        VALUES($1,$2,coalesce($3::boolean,false),coalesce($4::boolean,true))
        ON CONFLICT(workspace_id,user_id) DO UPDATE
        SET connected=coalesce($3,calendar_workspace_preferences.connected),
            visible=coalesce($4,calendar_workspace_preferences.visible)`,
        [scope.workspace_id,scope.user_id,patch.connected ?? null,patch.visible ?? null]);
    });
    return c.json({ok:true});
  });
  router.put('/events/:id/response', bodyLimit({maxSize: 256}), async c => {
    const body = await c.req.json().catch(() => undefined) as {response?: unknown} | undefined;
    const response = validCalendarResponse(body?.response);
    if (!response) throw new HTTPException(400, {message: 'Invalid response'});
    let answered: {workspace: string; notices: Notice[]} | null = null;
    const ok = await inTransaction(pool, async db => {
      const scope = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, true);
      const notice = await recordCalendarResponse(db, scope.workspace_id, c.req.param('id')!, scope.user_id, response);
      if (notice) answered = {workspace: scope.workspace_id, notices: [notice]};
      // Only a participant has a row to update; anyone else gets a 404.
      const {rowCount} = await db.query(
        'SELECT 1 FROM calendar_participants WHERE workspace_id=$1 AND event_id=$2 AND user_id=$3',
        [scope.workspace_id, c.req.param('id')!, scope.user_id]);
      return rowCount > 0;
    });
    if (!ok) throw new HTTPException(404, {message: 'Not invited to this event'});
    // Après le commit seulement : un e-mail ne doit pas annoncer une écriture annulée.
    if (answered?.notices.length) await deliverNotificationMails(pool, answered.workspace, answered.notices);
    return c.json({ok: true, response});
  });
  router.get('/invitees', async c => {
    const members = await inTransaction(pool, async db => {
      const scope = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, false);
      const {rows} = await db.query(`SELECT u.id, coalesce(nullif(u.name,''),nullif(u.email,''),'Profil local') AS title
        FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY title,u.id`, [scope.workspace_id]);
      return rows;
    });
    return c.json({members});
  });
  router.get('/', async c => {
    const events = await inTransaction(pool, async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scope = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, false);
      const { from, to, fromDay, toDay } = calendarRange(c.req.query());
      const { rows } = await db.query<Row>(
        `SELECT ${columns}, ARRAY(SELECT p.user_id FROM calendar_participants p
           WHERE p.workspace_id=e.workspace_id AND p.event_id=e.id ORDER BY p.user_id) AS participant_ids,
         (SELECT jsonb_object_agg(p.user_id,p.response) FROM calendar_participants p
           WHERE p.workspace_id=e.workspace_id AND p.event_id=e.id) AS participant_responses
         FROM workspace_calendar_events e WHERE workspace_id=$1 AND
          ((NOT all_day AND starts_at<$3 AND ends_at>$2) OR (all_day AND starts_at<$5 AND ends_at>$4))
         ORDER BY starts_at, ends_at, id`, [scope.workspace_id, from, to, fromDay, toDay]);
      const visible = rows.some(event => event.page_id) ? await visiblePages(db, scope) : null;
      return rows.flatMap(event => {
        if (!event.detached_private && (!event.page_id || visible?.has(event.page_id))) return [eventData(event)];
        const isOrganizer = event.organizer_id === scope.user_id;
        if ((isOrganizer && (event.detached_private || event.participant_ids?.length)) || event.participant_ids?.includes(scope.user_id)) {
          return [{...eventData(event),pageId:null,readOnly:!!event.page_id || event.organizer_id !== scope.user_id}];
        }
        return [];
      });
    });
    return c.json({ events });
  });

  router.on(['PUT', 'DELETE'], '/:id', bodyLimit({ maxSize: 8192, onError: c => c.json({error:'Événement trop volumineux.'}, 413) }), async c => {
    const write = c.req.method === 'PUT';
    const id = c.req.param('id')!;
    const raw = write ? await c.req.json().catch(() => null) : null;
    let invited: {workspace: string; notices: Notice[]} | null = null;
    const result = await inTransaction(pool, async db => {
      const scope = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, true);
      if (scope.role === 'viewer') throw new WorkspaceError(403, 'Ce calendrier est en lecture seule.');
      if (!uuid.test(id)) throw new WorkspaceError(400, 'Identifiant du calendrier invalide.');
      const input = write ? calendarInput(id, raw) : null;
      const revisionParam = c.req.query('revision') ?? '';
      const revision = input ? input.revision : /^\d+$/.test(revisionParam) ? Number(revisionParam) : NaN;
      if (!isRevision(revision) || (!write && revision === 0)) throw new WorkspaceError(400, 'Révision du calendrier invalide.');
      const key = [scope.workspace_id, id];
      // The workspace lock serializes this check with event writers and sharing changes.
      const {rows: [current]} = await db.query<Pick<Row,'page_id'|'revision'|'detached_private'|'organizer_id'>>(
        'SELECT page_id,revision,detached_private,organizer_id FROM workspace_calendar_events WHERE workspace_id=$1 AND id=$2', key);
      if (current?.detached_private && current.organizer_id !== scope.user_id) throw notFound();
      if (current?.page_id || input?.pageId) {
        const visible = await visiblePages(db, scope);
        if ((current?.page_id && !visible.has(current.page_id)) || (input?.pageId && !visible.has(input.pageId))) throw notFound();
      }
      if (!current && revision > 0) throw notFound();
      if (current && current.revision !== revision) throw conflict();
      if (!input) {
        await db.query('DELETE FROM workspace_calendar_events WHERE workspace_id=$1 AND id=$2', key);
        return { ok: true };
      }
      const { rows: [saved] } = await db.query<Row>(
        `INSERT INTO workspace_calendar_events(workspace_id,id,title,starts_at,ends_at,all_day,page_id,organizer_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(workspace_id,id) DO UPDATE SET title=excluded.title, starts_at=excluded.starts_at,
           ends_at=excluded.ends_at, all_day=excluded.all_day, page_id=excluded.page_id,
           organizer_id=coalesce(workspace_calendar_events.organizer_id,excluded.organizer_id), revision=workspace_calendar_events.revision+1
         RETURNING ${columns}`, [...key, input.title, input.start, input.end, input.allDay, input.pageId,scope.user_id]);
      if (input.participantIds !== undefined) {
        const members = await db.query(
          'SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=ANY($2::text[])',
          [scope.workspace_id, input.participantIds]);
        if (members.rowCount !== input.participantIds.length) throw new WorkspaceError(400, 'Choisissez des membres de cet espace.');
        const params = [...key, input.participantIds];
        await db.query('DELETE FROM calendar_participants WHERE workspace_id=$1 AND event_id=$2 AND NOT(user_id=ANY($3::text[]))', params);
        const created = await db.query<Notice>(`WITH added AS (
            INSERT INTO calendar_participants(workspace_id,event_id,user_id)
            SELECT $1,$2,u FROM unnest($3::text[]) u ON CONFLICT DO NOTHING RETURNING user_id)
          INSERT INTO workspace_notifications(workspace_id,event_id,recipient_id,actor_id,type)
          SELECT $1,$2,user_id,$4,'calendar_invitation' FROM added WHERE user_id<>$4
          RETURNING recipient_id,type`, [...params, scope.user_id]);
        invited = {workspace: scope.workspace_id, notices: created.rows};
      }
      const participants = await db.query<{user_id:string}>(
        'SELECT user_id FROM calendar_participants WHERE workspace_id=$1 AND event_id=$2 ORDER BY user_id', key);
      return { event: eventData({...saved!, participant_ids:participants.rows.map(p => p.user_id)}) };
    });
    // Après le commit seulement : un e-mail ne doit pas annoncer une écriture annulée.
    if (invited?.notices.length) await deliverNotificationMails(pool, invited.workspace, invited.notices);
    return c.json(result);
  });
  return router;
}
