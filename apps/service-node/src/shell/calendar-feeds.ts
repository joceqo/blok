import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { openCalendarSecret, sealCalendarSecret } from './calendar-secrets.ts';
import { sessionDigest } from './session.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';

export function feedUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.replace(/^webcal:\/\//i, 'https://')); }
  catch { throw new WorkspaceError(400, 'Adresse de calendrier invalide.'); }
  const host = url.hostname;
  const supported = host === 'calendar.google.com' && url.pathname.startsWith('/calendar/ical/') ||
    ['outlook.office365.com', 'outlook.office.com', 'outlook.live.com'].includes(host) && /\.ics$/i.test(url.pathname) ||
    /^(?:p\d+-)?caldav\.icloud\.com$/.test(host) && url.pathname.startsWith('/published/');
  if (!supported || url.username || url.password || url.port || url.protocol !== 'https:' || url.hash || raw.length > 4096) {
    throw new WorkspaceError(400, 'Utilisez un lien d’abonnement Google Agenda, Outlook ou iCloud.');
  }
  return url;
}

export async function fetchCalendarFeed(raw: string, request = fetch): Promise<string> {
  let url = feedUrl(raw);
  const signal = AbortSignal.timeout(8000);
  try {
    for (let i = 0; i < 4; i++) {
      const response = await request(url, {signal, redirect: 'manual', headers: {Accept: 'text/calendar'}});
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        await response.body?.cancel();
        url = feedUrl(new URL(response.headers.get('location')!, url).href);
        continue;
      }
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 2_000_000) {
        await response.body?.cancel(); break;
      }
      const chunks: Uint8Array[] = [];
      const reader = response.body.getReader();
      let size = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) { await reader.cancel(); throw new Error('Size limit'); }
        chunks.push(value);
      }
      const data = Buffer.concat(chunks).toString('utf8').trim();
      if (!/^BEGIN:VCALENDAR\r?\n/i.test(data)) break;
      return data;
    }
  } catch { /* Provider errors may contain a secret subscription URL. */ }
  throw new HTTPException(502, {message: 'Impossible de lire ce calendrier auprès du fournisseur.'});
}

export function calendarFeedRoutes(pool: PgPool, secret: string) {
  const app = new Hono();
  const base = '/api/workspaces/:slug/calendar/feeds';
  app.get(base, async c => {
    const feeds = await inTransaction(pool, async db => {
      const s = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, false);
      return (await db.query('SELECT id,label FROM workspace_calendar_feeds WHERE workspace_id=$1 AND user_id=$2 ORDER BY label,id', [s.workspace_id,s.user_id])).rows;
    });
    return c.json({feeds});
  });
  app.post(base, bodyLimit({maxSize: 8192}), async c => {
    const data = await c.req.json().catch(() => null);
    if (typeof data?.url !== 'string' || typeof data?.label !== 'string' || !data.label.trim() || data.label.length > 120) throw new WorkspaceError(400, 'Nom ou URL manquant.');
    const url = feedUrl(data.url);
    const label = data.label.trim(), id = randomUUID();
    await inTransaction(pool, async db => {
      const s = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, true);
      const args = [s.workspace_id, s.user_id];
      const count = await db.query('SELECT count(*)::int AS n FROM workspace_calendar_feeds WHERE workspace_id=$1 AND user_id=$2', args);
      if (count.rows[0].n >= 12) throw new WorkspaceError(400, 'Limite de 12 abonnements atteinte.');
      const encrypted = sealCalendarSecret(secret, JSON.stringify(['feed', ...args, id]), url.href);
      await db.query('INSERT INTO workspace_calendar_feeds(workspace_id,user_id,id,label,secret) VALUES($1,$2,$3,$4,$5)', [...args,id,label,encrypted]);
    });
    return c.json({id,label}, 201);
  });
  app.on(['GET','DELETE'], base + '/:id', async c => {
    const remove = c.req.method === 'DELETE', id = c.req.param('id') ?? '';
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id)) throw new WorkspaceError(404,'Abonnement introuvable.');
    const url = await inTransaction(pool, async db => {
      const s = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug')!, remove);
      const args = [s.workspace_id,s.user_id,id];
      const where = ' WHERE workspace_id=$1 AND user_id=$2 AND id=$3';
      const result = await db.query(remove ? 'DELETE FROM workspace_calendar_feeds' + where + ' RETURNING id' : 'SELECT secret FROM workspace_calendar_feeds' + where, args);
      if (!result.rowCount) throw new WorkspaceError(404,'Abonnement introuvable.');
      return remove ? '' : openCalendarSecret(secret, JSON.stringify(['feed', ...args]), result.rows[0].secret);
    });
    return remove ? c.json({ok:true}) : c.json({ical: await fetchCalendarFeed(url)});
  });
  return app;
}
