import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import type { PgPool } from '../db/pool.ts';
import { openCalendarSecret, sealCalendarSecret } from './calendar-secrets.ts';

const api = 'https://www.googleapis.com/calendar/v3/';
export const calendarScope = 'https://www.googleapis.com/auth/calendar.readonly';
export const googleCallback = '/api/calendar/google/callback';
const unavailable = () => new HTTPException(503, {message:'Google Agenda est temporairement indisponible.'});
export const reconnect = () => new HTTPException(409, {message:'Reconnectez votre compte Google Agenda.'});

type Config = { clientId: string; clientSecret: string; redirect: string; loopback: boolean };
function googleConfig(env: NodeJS.ProcessEnv): Config | undefined {
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET, redirect = env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirect) return;
  try {
    const url = new URL(redirect);
    // An installed app serves this same callback on the loopback port its
    // instance was given. It still belongs to the origin the server announces.
    const loopback = url.protocol === 'http:' && ['localhost','127.0.0.1','::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !loopback) return;
    if (url.username || url.password || url.search || url.hash || url.pathname !== googleCallback ||
        (env.PUBLIC_URL && url.origin !== new URL(env.PUBLIC_URL).origin)) return;
    return {clientId,clientSecret,redirect,loopback};
  } catch { return; }
}

interface Token { access_token: string; refresh_token?: string; expires_in: number; scope?: string }
interface Connection { access_secret: string; refresh_secret: string; access_expires_at: Date }
interface GoogleDate { date?: string; dateTime?: string }
interface GoogleEvent { id: string; summary?: string; status?: string; start?: GoogleDate; end?: GoogleDate }
interface GoogleListEntry { id: string; summary: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; accessRole: string }
type Busy = { start: string; end: string };
type JsonResponse = { response: Response; json: Record<string, unknown> };

export function createGoogleCalendarProvider(secret: string, env = process.env, http: typeof fetch = fetch) {
  const config = googleConfig(env);
  function requireConfig() {
    if (!config) throw new HTTPException(503, {message:'Google Agenda doit être configuré par l’administrateur du serveur Blok.'});
    return config;
  }
  async function fetchJson(url: string, init: RequestInit): Promise<JsonResponse> {
    try {
      const response = await http(url, {...init, redirect:'error', signal:AbortSignal.timeout(12_000)});
      const json: unknown = await response.json();
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw unavailable();
      return {response,json:json as Record<string,unknown>};
    } catch { throw unavailable(); }
  }
  async function tokenRequest(params: Record<string,string>) {
    const {clientId,clientSecret} = requireConfig();
    const {response,json} = await fetchJson('https://oauth2.googleapis.com/token', {
      method:'POST', body:new URLSearchParams({...params,client_id:clientId,client_secret:clientSecret}),
    });
    if (!response.ok) {
      if (json.error === 'invalid_grant') throw reconnect();
      throw unavailable();
    }
    if (typeof json.access_token !== 'string' || !json.access_token || typeof json.expires_in !== 'number' ||
        !Number.isFinite(json.expires_in) || json.expires_in <= 0) throw unavailable();
    return json as unknown as Token;
  }
  const context = (workspaceId: string, userId: string, kind: string) => JSON.stringify(['google',workspaceId,userId,kind]);
  const encrypt = (w: string, u: string, kind: string, value: string) => sealCalendarSecret(secret,context(w,u,kind),value);
  const decrypt = (w: string, u: string, kind: string, value: string) => openCalendarSecret(secret,context(w,u,kind),value);

  async function access(pool: PgPool, w: string, u: string) {
    const {rows:[row]} = await pool.query<Connection>('SELECT access_secret,refresh_secret,access_expires_at FROM calendar_google_connections WHERE workspace_id=$1 AND user_id=$2',[w,u]);
    if (!row) throw reconnect();
    requireConfig();
    if (row.access_expires_at.getTime() > Date.now()+60_000) return decrypt(w,u,'access',row.access_secret);
    const refresh = decrypt(w,u,'refresh',row.refresh_secret);
    let token: Token;
    try { token = await tokenRequest({grant_type:'refresh_token',refresh_token:refresh}); }
    catch (error) {
      if (error instanceof HTTPException && error.status === 409) {
        await pool.query(`WITH revoked AS (
          DELETE FROM calendar_google_connections WHERE workspace_id=$1 AND user_id=$2 AND refresh_secret=$3
          RETURNING workspace_id,user_id
        ) DELETE FROM calendar_availability_shares s USING revoked r
          WHERE s.workspace_id=r.workspace_id AND s.user_id=r.user_id`,[w,u,row.refresh_secret]);
      }
      throw error;
    }
    const saved = await pool.query(`UPDATE calendar_google_connections SET access_secret=$4,access_expires_at=$5,
      refresh_secret=coalesce($6,refresh_secret) WHERE workspace_id=$1 AND user_id=$2 AND refresh_secret=$3`,
    [w,u,row.refresh_secret,encrypt(w,u,'access',token.access_token),new Date(Date.now()+token.expires_in*1000),
      token.refresh_token ? encrypt(w,u,'refresh',token.refresh_token) : null]);
    if (!saved.rowCount) throw reconnect();
    return token.access_token;
  }

  async function google(url: URL, accessToken: string, body?: object) {
    const {response,json} = await fetchJson(url.href, { method:body ? 'POST' : 'GET', headers:{authorization:'Bearer '+accessToken,...(body ? {'content-type':'application/json'} : {})}, body: body && JSON.stringify(body) });
    if (response.status === 401) throw reconnect();
    if (response.status === 404) throw new HTTPException(404,{message:'Agenda Google introuvable.'});
    if (response.status === 403) throw new HTTPException(403,{message:'Accès Google Agenda refusé.'});
    if (!response.ok) throw unavailable();
    return json;
  }
  async function pages<T>(url: URL, token: string): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    while (true) {
      const result = await google(url, token);
      if (result.items !== undefined && !Array.isArray(result.items)) throw unavailable();
      items.push(...(result.items as T[] | undefined ?? []));
      if (result.nextPageToken === undefined) return items;
      if (typeof result.nextPageToken !== 'string' || !result.nextPageToken || seen.has(result.nextPageToken)) throw unavailable();
      seen.add(result.nextPageToken);
      url.searchParams.set('pageToken',result.nextPageToken);
    }
  }

  return {
    config, requireConfig,
    async exchange(code: string, verifier: string) {
      const token = await tokenRequest({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:requireConfig().redirect});
      if (!token.refresh_token || !token.scope?.split(' ').includes(calendarScope)) throw reconnect();
      return token;
    },
    encrypt,
    async calendars(pool: PgPool, w: string, u: string) {
      const token = await access(pool,w,u);
      const url = new URL('users/me/calendarList',api);
      url.search = new URLSearchParams({minAccessRole:'freeBusyReader',maxResults:'250',fields:'nextPageToken,items(id,summary,summaryOverride,backgroundColor,primary,accessRole)'}).toString();
      return (await pages<GoogleListEntry>(url,token)).map(item=>({id:item.id,title:item.summaryOverride ?? item.summary,
        ...(item.accessRole === 'freeBusyReader' && {busyOnly:true}), color:/^#[\da-f]{6}$/i.test(item.backgroundColor ?? '') ? item.backgroundColor : '#4285f4',primary:item.primary === true}));
    },
    async events(pool: PgPool, w: string, u: string, calendarId: string, from: string, to: string) {
      const token = await access(pool,w,u);
      const url = new URL('calendars/'+encodeURIComponent(calendarId)+'/events',api);
      url.search = new URLSearchParams({timeMin:from,timeMax:to,singleEvents:'true',orderBy:'startTime',maxResults:'2500',fields:'nextPageToken,items(id,status,summary,start,end)'}).toString();
      const result = await pages<GoogleEvent>(url,token);
      return result.flatMap(event=>{
        if (event.status === 'cancelled' || !event.start || !event.end || !event.id) return [];
        const allDay = !!event.start.date;
        const start = allDay ? event.start.date : event.start.dateTime;
        const end = allDay ? event.end.date : event.end.dateTime;
        if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return [];
        const id = 'google-' + createHash('sha256').update(JSON.stringify([calendarId,event.id])).digest('hex');
        return [{id,title:event.summary || 'Occupé',allDay,start:allDay ? start : new Date(start).toISOString(),
          end:allDay ? end : new Date(end).toISOString(),pageId:null,revision:0}];
      });
    },
    async freeBusy(pool: PgPool, w: string, u: string, from: string, to: string, calendarId = 'primary'): Promise<Busy[]> {
      const token = await access(pool,w,u);
      const data = await google(new URL('freeBusy',api),token,{timeMin:from,timeMax:to,items:[{id:calendarId}]});
      const calendar = (data.calendars as Record<string, {busy?: Busy[]; errors?: unknown[]}> | undefined)?.[calendarId];
      if (calendar?.errors?.length || !Array.isArray(calendar?.busy)) throw unavailable();
      return calendar.busy.map(({start,end})=>({start,end}));
    },
  };
}
export type GoogleCalendarProvider = ReturnType<typeof createGoogleCalendarProvider>;
