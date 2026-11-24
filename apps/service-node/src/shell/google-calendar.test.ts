import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PgPool } from '../db/pool.ts';
import { describe, expect, it, vi } from 'vitest';
import { googleCalendarRoutes } from './google-calendar.ts';
import { calendarScope, createGoogleCalendarProvider } from './google-calendar-provider.ts';
import { openCalendarSecret, sealCalendarSecret } from './calendar-secrets.ts';

const secret = 'x'.repeat(32);
const env = {GOOGLE_CALENDAR_CLIENT_ID:'client',GOOGLE_CALENDAR_CLIENT_SECRET:'secret',
  GOOGLE_CALENDAR_REDIRECT_URI:'https://example.org/api/calendar/google/callback',PUBLIC_URL:'https://example.org'};
const from = '2026-11-23T00:00:00.000Z', to = '2026-11-30T00:00:00.000Z';
const reply = (data: unknown, status=200) => new Response(JSON.stringify(data),{status});

function poolWithToken() {
  const row = {access_secret:sealCalendarSecret(secret,JSON.stringify(['google','w','u','access']),'access'),
    refresh_secret:sealCalendarSecret(secret,JSON.stringify(['google','w','u','refresh']),'refresh'),access_expires_at:new Date(Date.now()+120000)};
  const query = vi.fn(async () => ({rows:[row],rowCount:1}));
  return {pool:{query} as unknown as PgPool,query,row};
}

it('isolates encrypted credentials by owner, type and server key', () => {
  const cipher = sealCalendarSecret(secret,'account A','sensitive');
  expect(openCalendarSecret(secret,'account A',cipher)).toBe('sensitive');
  expect(()=>openCalendarSecret(secret,'account B',cipher)).toThrow();
  expect(()=>openCalendarSecret('another key','account A',cipher)).toThrow();
});

it('requires an exact registered server callback', () => {
  for (const redirect of ['https://elsewhere.org/api/calendar/google/callback','http://example.org/api/calendar/google/callback','https://example.org/calendar','https://example.org/api/calendar/google/callback?x=1']) {
    expect(createGoogleCalendarProvider(secret,{...env,GOOGLE_CALENDAR_REDIRECT_URI:redirect}).config).toBeUndefined();
  }
  expect(createGoogleCalendarProvider(secret,{}).config).toBeUndefined();
  expect(createGoogleCalendarProvider(secret,env).config?.redirect).toBe(env.GOOGLE_CALENDAR_REDIRECT_URI);
});

it('forwards only FreeBusy windows from the primary calendar for a connected account', async () => {
  const {pool} = poolWithToken();
  const http = vi.fn<typeof fetch>(async (url,init) => {
    expect(String(url)).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(JSON.parse(String(init?.body))).toEqual({timeMin:from,timeMax:to,items:[{id:'primary'}]});
    return reply({calendars:{primary:{busy:[{start:from,end:to,summary:'private title'}]}}});
  });
  const provider = createGoogleCalendarProvider(secret,env,http);
  expect(await provider.freeBusy(pool,'w','u',from,to)).toEqual([{start:from,end:to}]);
  await expect(provider.freeBusy({query:async()=>({rows:[]})} as unknown as PgPool,'w','none',from,to)).rejects.toMatchObject({status:409});
  expect(http).toHaveBeenCalledTimes(1);
});

it('refreshes expiring credentials only on the server', async () => {
  const {pool,row,query} = poolWithToken();
  row.access_expires_at = new Date(0);
  const http = vi.fn<typeof fetch>(async (url,init) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      const form = init?.body as URLSearchParams;
      expect(form.get('refresh_token')).toBe('refresh');
      expect(form.get('grant_type')).toBe('refresh_token');
      return reply({access_token:'early-next',expires_in:3600});
    }
    expect(init?.headers).toMatchObject({authorization:'Bearer early-next'});
    return reply({items:[]});
  });
  expect(await createGoogleCalendarProvider(secret,env,http).calendars(pool,'w','u')).toEqual([]);
  expect(query).toHaveBeenCalledTimes(2);
});

it('pages through calendar lists and expanded occurrences, preserving floating dates', async () => {
  const {pool} = poolWithToken();
  const http = vi.fn<typeof fetch>(async (raw,init) => {
    const url = new URL(String(raw));
    expect(init?.headers).toMatchObject({authorization:'Bearer access'});
    if (url.pathname.endsWith('calendarList')) {
      return reply(url.searchParams.has('pageToken') ? {items:[{id:'B',summary:'Perso'}]} :
        {items:[{id:'A',summary:'Mon agenda',primary:true,backgroundColor:'#12abcd'}],nextPageToken:'2'});
    }
    expect(url.pathname).toBe('/calendar/v3/calendars/team%40example.org/events');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('timeMin')).toBe(from);
    return reply(url.searchParams.has('pageToken') ? {items:[
      {id:'2',summary:'Journée',start:{date:'2026-11-25'},end:{date:'2026-11-26'}},
      {id:'3',status:'cancelled'}]} : {items:[{id:'1',start:{dateTime:'2026-11-24T14:00:00+01:00'},end:{dateTime:'2026-11-24T15:00:00+01:00'}}],nextPageToken:'2'});
  });
  const google = createGoogleCalendarProvider(secret,env,http);
  expect(await google.calendars(pool,'w','u')).toEqual([{id:'A',title:'Mon agenda',primary:true,color:'#12abcd'},{id:'B',title:'Perso',primary:false,color:'#4285f4'}]);
  expect(await google.events(pool,'w','u','team@example.org',from,to)).toMatchObject([
    {start:'2026-11-24T13:00:00.000Z',end:'2026-11-24T14:00:00.000Z',allDay:false,title:'Occupé'},
    {start:'2026-11-25',end:'2026-11-26',allDay:true,title:'Journée'}]);
});

describe('OAuth consent',()=>{
  it('rejects missing read permission and failed exchanges',async()=>{
    const partial=()=>Promise.resolve(reply({access_token:'access',refresh_token:'refresh',expires_in:100,scope:'profile'}));
    await expect(createGoogleCalendarProvider(secret,env,partial).exchange('code','verifier')).rejects.toMatchObject({status:409});
    const fail=()=>Promise.resolve(reply({error:'invalid_grant'},400));
    await expect(createGoogleCalendarProvider(secret,env,fail).exchange('code','verifier')).rejects.toMatchObject({status:409});
    expect(calendarScope).toMatch(/calendar\.readonly$/);
  });
  it('gives a browser sign-in path and makes no Google request without the Blok session',async()=>{
    const http=vi.fn();
    const app = new Hono().route('/',googleCalendarRoutes({} as PgPool,createGoogleCalendarProvider(secret,env,http)));
    app.onError((error,c)=>c.json({error:error.message},error instanceof HTTPException ? error.status : 500));
    const res=await app.request('/api/calendar/google/callback?state=anything&code=x');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('href="/"');
    expect(http).not.toHaveBeenCalled();
  });
});
