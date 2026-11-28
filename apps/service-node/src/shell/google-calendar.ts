import { createHash, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { calendarRange } from './calendar.ts';
import { calendarScope, googleCallback, type GoogleCalendarProvider } from './google-calendar-provider.ts';
import { sessionDigest } from './session.ts';
import { readWorkspaceScope } from './workspace-scope.ts';

const base = '/api/workspaces/:slug/calendar/google';
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const invalidState = () => new HTTPException(400, {message:'Autorisation expirée ou déjà utilisée. Recommencez depuis le calendrier du même compte Blok.'});

// The browser lands here from Google, outside the app's own styling. Keep it a
// single self-contained document: no asset the loopback server would have to serve.
const page = (title: string, mark: string, heading: string, note: string, link = '') => `<!doctype html>
<html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#fff;color:#37352f}
main{max-width:26rem;padding:2rem;text-align:center}
.mark{width:3rem;height:3rem;margin:0 auto 1.25rem;border-radius:50%;display:grid;place-items:center;
  font-size:1.5rem;background:#edf7f1;color:#2f7d58}
h1{margin:0 0 .5rem;font-size:1.3rem;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:#787774}
a{display:inline-block;margin-top:1.5rem;padding:.55rem 1.1rem;border-radius:.4rem;
  background:#37352f;color:#fff;text-decoration:none;font-size:.9rem}
@media (prefers-color-scheme:dark){
  body{background:#191919;color:#e9e9e7}
  p{color:#9b9a97}
  .mark{background:#1f2f27;color:#6cc39a}
  a{background:#e9e9e7;color:#191919}}
</style>
<main><div class="mark">${mark}</div><h1>${heading}</h1><p>${note}</p>${link}</main></html>`;

export function googleCalendarRoutes(pool: PgPool, google: GoogleCalendarProvider) {
  const router = new Hono();
  const scope = (c: Context) => inTransaction(pool,db => readWorkspaceScope(db,sessionDigest(c) ?? '',c.req.param('slug')!,false));
  router.get(base+'/status', async c => {
    const {workspace_id,user_id} = await scope(c);
    const {rowCount} = await pool.query('SELECT FROM calendar_google_connections WHERE workspace_id=$1 AND user_id=$2',[workspace_id,user_id]);
    return c.json({configured:!!google.config,connected:!!rowCount});
  });
  router.post(base+'/connect', async c => {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const url = await inTransaction(pool,async db=>{
      const {workspace_id,user_id} = await readWorkspaceScope(db,sessionDigest(c) ?? '',c.req.param('slug')!,true);
      const config = google.requireConfig();
      await db.query('DELETE FROM calendar_google_states WHERE expires_at<=now()');
      await db.query(`INSERT INTO calendar_google_states(digest,workspace_id,user_id,verifier,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '10 minutes') ON CONFLICT(workspace_id,user_id) DO UPDATE SET
        digest=excluded.digest,verifier=excluded.verifier,expires_at=excluded.expires_at,used=false`,[hash(state),workspace_id,user_id,verifier]);
      const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      target.search = new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirect,response_type:'code',scope:calendarScope,
        state,code_challenge_method:'S256',code_challenge:hash(verifier),access_type:'offline',prompt:'consent'}).toString();
      return target.href;
    });
    return c.json({url});
  });

  router.get(googleCallback,async c=>{
    c.header('Referrer-Policy','no-referrer');
    const state = c.req.query('state') ?? '';
    const digest = sessionDigest(c);
    // An installed app answers on its own loopback port, and the system browser
    // holds no Blok cookie for it. Google can only deliver that consent to the
    // machine that asked for it, so the one-time state stands in for the session.
    const installed = google.config?.loopback === true;
    if (!digest && !installed) return c.html(page('Connexion à Blok','→','Connectez-vous à Blok',
      'Ouvrez le même compte Blok dans ce navigateur, puis recommencez la connexion à Google Agenda depuis le calendrier.',
      '<a href="/">Ouvrir Blok</a>'),401);
    if (!/^[\w-]{43}$/.test(state)) throw invalidState();
    // Bind Google consent to the Blok account in the returning browser. A copied
    // consent link cannot attach someone else's Google account to its sender.
    const {rows:[authorization]} = installed
      ? await pool.query<{workspace_id:string;user_id:string;verifier:string}>(
        `UPDATE calendar_google_states SET used=true
         WHERE digest=$1 AND expires_at>now() AND NOT used
         RETURNING workspace_id,user_id,verifier`,[hash(state)])
      : await pool.query<{workspace_id:string;user_id:string;verifier:string}>(
        `UPDATE calendar_google_states a SET used=true FROM sessions s
         WHERE a.digest=$1 AND a.expires_at>now() AND NOT a.used AND s.id=$2 AND s.expires_at>now() AND s.user_id=a.user_id
         RETURNING a.workspace_id,a.user_id,a.verifier`,[hash(state),digest]);
    if (!authorization) throw invalidState();
    const code = c.req.query('code');
    if (c.req.query('error') || !code || code.length>8192) throw new HTTPException(400,{message:'Connexion à Google Agenda annulée. Vous pouvez fermer cet onglet.'});
    const {workspace_id:w,user_id:u,verifier} = authorization;
    const token = await google.exchange(code,verifier);
    await inTransaction(pool,async db=>{
      if (installed) {
        const member = await db.query('SELECT FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[w,u]);
        if (!member.rowCount) throw invalidState();
      } else await readWorkspaceScope(db,digest ?? '',w,true);
      const consumed = await db.query('DELETE FROM calendar_google_states WHERE workspace_id=$1 AND user_id=$2 AND digest=$3 AND used AND expires_at>now()',[w,u,hash(state)]);
      if (!consumed.rowCount) throw invalidState();
      await db.query(`INSERT INTO calendar_google_connections(workspace_id,user_id,refresh_secret,access_secret,access_expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,user_id) DO UPDATE SET refresh_secret=excluded.refresh_secret,
        access_secret=excluded.access_secret,access_expires_at=excluded.access_expires_at`,
      [w,u,google.encrypt(w,u,'refresh',token.refresh_token!),google.encrypt(w,u,'access',token.access_token),new Date(Date.now()+token.expires_in*1000)]);
      // A replacement account needs a fresh decision before sharing availability.
      await db.query('DELETE FROM calendar_availability_shares WHERE workspace_id=$1 AND user_id=$2',[w,u]);
    });
    // The installed app owns the window the user came from; this tab is done.
    return installed
      ? c.html(page('Google Agenda connecté','✓','Google Agenda est connecté',
        'Vous pouvez fermer cet onglet et revenir à Blok.'))
      : c.redirect('/?view=calendar',303);
  });

  router.delete(base+'/connection',async c=>{
    await inTransaction(pool,async db=>{
      const {workspace_id,user_id} = await readWorkspaceScope(db,sessionDigest(c) ?? '',c.req.param('slug')!,true);
      const key = [workspace_id,user_id];
      await db.query('DELETE FROM calendar_google_states WHERE workspace_id=$1 AND user_id=$2',key);
      await db.query('DELETE FROM calendar_availability_shares WHERE workspace_id=$1 AND user_id=$2',key);
      await db.query('DELETE FROM calendar_google_connections WHERE workspace_id=$1 AND user_id=$2',key);
    });
    return c.json({ok:true});
  });
  router.get(base+'/calendars',async c=>{
    const {workspace_id,user_id} = await scope(c);
    return c.json({calendars:await google.calendars(pool,workspace_id,user_id)});
  });
  router.get(base+'/events',async c=>{
    const {workspace_id,user_id} = await scope(c);
    const {from,to} = calendarRange(c.req.query());
    const calendarId = c.req.query('calendarId') ?? 'primary';
    if (!calendarId || calendarId.length>1024 || /[\x00-\x1f]/.test(calendarId) || calendarId === '.' || calendarId === '..') {
      throw new HTTPException(400,{message:'Agenda Google invalide.'});
    }
    if (c.req.query('busyOnly') === '1') {
      const busy = await google.freeBusy(pool,workspace_id,user_id,from,to,calendarId);
      return c.json({events:busy.map(slot => ({...slot,id:slot.start,title:'Occupé',allDay:false,pageId:null,revision:0}))});
    }
    return c.json({events:await google.events(pool,workspace_id,user_id,calendarId,from,to)});
  });
  return router;
}
