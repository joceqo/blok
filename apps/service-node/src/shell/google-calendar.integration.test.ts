import { createHash,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {WorkspaceError} from './workspace-scope.ts';
import {googleCalendarRoutes} from './google-calendar.ts';
import {calendarScope,createGoogleCalendarProvider} from './google-calendar-provider.ts';

const url=process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('Google calendar account binding and isolation',()=>{
  const schema='gcal_'+randomUUID().replaceAll('-','');
  const owner=new pg.Pool({connectionString:url});
  const db=new pg.Pool({connectionString:url,options:'-csearch_path='+schema});
  const env={GOOGLE_CALENDAR_CLIENT_ID:'client',GOOGLE_CALENDAR_CLIENT_SECRET:'client-secret',GOOGLE_CALENDAR_REDIRECT_URI:'https://blok.example/api/calendar/google/callback'};
  const http=vi.fn<typeof fetch>();
  const app=new Hono().route('/',googleCalendarRoutes(db,createGoogleCalendarProvider('secret'.repeat(8),env,http)));
  app.onError((e,c)=>c.json({error:e.message},e instanceof WorkspaceError || e instanceof HTTPException ? e.status : 500));
  const call=(user:string,path:string,method='GET')=>app.request(path,{method,headers:{Cookie:'blok_session='+user}});
  const base='/api/workspaces/alpha/calendar/google/';
  const hash=(s:string)=>createHash('sha256').update(s).digest('base64url');
  beforeAll(async()=>{
    await owner.query('CREATE SCHEMA '+schema);
    await db.query(await readFile(process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql',import.meta.url),'utf8'));
    await db.query(`INSERT INTO users(id,email) VALUES('alice','alice@example.test'),('bob','bob@example.test');
      INSERT INTO workspaces(id,slug,name) VALUES('a','alpha','Alpha'),('b','beta','Beta');
      INSERT INTO memberships VALUES ('a','alice','member'),('a','bob','viewer'),('b','alice','member')`);
    for (const id of ['alice','bob']) await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [createHash('sha256').update(id).digest('hex'),id]);
  });
  afterAll(async()=>{
    await db.end();
    try{await owner.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE')}finally{await owner.end()}
  });

  it('requires the initiating account on callback, consumes state once, persists encrypted credentials, detaches only this connection',async()=>{
    expect(await (await call('alice',base+'status')).json()).toEqual({configured:true,connected:false});
    const start=await call('alice',base+'connect','POST');
    const auth=new URL((await start.json()).url), state=auth.searchParams.get('state')!;
    expect(auth.origin).toBe('https://accounts.google.com');
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.get('scope')).toBe(calendarScope);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    const pending=(await db.query('SELECT digest,verifier FROM calendar_google_states')).rows[0];
    expect(pending.digest).toBe(hash(state));
    expect(auth.searchParams.get('code_challenge')).toBe(hash(pending.verifier));
    const callback='/api/calendar/google/callback?state='+state+'&code=authorization-code';
    expect((await call('bob',callback)).status).toBe(400);
    expect(http).not.toHaveBeenCalled();
    http.mockImplementationOnce(async(url,options)=>{
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      const body=options?.body as URLSearchParams;
      expect(body.get('code_verifier')).toBe(pending.verifier);
      expect(body.get('redirect_uri')).toBe(env.GOOGLE_CALENDAR_REDIRECT_URI);
      return Response.json({access_token:'plain-access',refresh_token:'plain-refresh',expires_in:3600,scope:calendarScope});
    });
    const connected = await call('alice',callback);
    expect(connected.status).toBe(303);
    expect(connected.headers.get('location')).toBe('/?view=calendar');
    expect((await call('alice',callback)).status).toBe(400);
    expect(http).toHaveBeenCalledTimes(1);
    const row=(await db.query('SELECT * FROM calendar_google_connections')).rows[0];
    expect(row.access_secret).not.toContain('plain-access');
    expect(row.refresh_secret).not.toContain('plain-refresh');
    expect(await (await call('alice',base+'status')).json()).toEqual({configured:true,connected:true});
    expect(await (await call('bob',base+'status')).json()).toEqual({configured:true,connected:false});
    expect(await (await call('alice',base.replace('/alpha/','/beta/')+'status')).json()).toEqual({configured:true,connected:false});
    expect((await call('bob',base+'events?from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z')).status).toBe(409);
    const another=await (await call('alice',base+'connect','POST')).json();
    await db.query("INSERT INTO calendar_availability_shares VALUES('a','alice')");
    expect((await call('alice',base+'connection','DELETE')).status).toBe(200);
    expect((await db.query('SELECT FROM calendar_availability_shares')).rowCount).toBe(0);
    expect((await call('alice','/api/calendar/google/callback?state='+new URL(another.url).searchParams.get('state')+'&code=x')).status).toBe(400);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('completes an installed-app consent on the loopback callback, where no browser carries a Blok session',async()=>{
    // The desktop app opens the system browser, which has no cookie for the
    // server it just started on 127.0.0.1. Google can only answer on that
    // machine's own loopback port, so the one-time state identifies the account.
    const installed={...env,GOOGLE_CALENDAR_REDIRECT_URI:'http://127.0.0.1:52430/api/calendar/google/callback',PUBLIC_URL:'http://127.0.0.1:52430'};
    const local=vi.fn<typeof fetch>();
    const app=new Hono().route('/',googleCalendarRoutes(db,createGoogleCalendarProvider('secret'.repeat(8),installed,local)));
    app.onError((e,c)=>c.json({error:e.message},e instanceof WorkspaceError || e instanceof HTTPException ? e.status : 500));
    const start=await app.request(base+'connect',{method:'POST',headers:{Cookie:'blok_session=bob'}});
    const state=new URL((await start.json()).url).searchParams.get('state')!;
    local.mockImplementationOnce(async(url,options)=>{
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      expect((options?.body as URLSearchParams).get('redirect_uri')).toBe(installed.GOOGLE_CALENDAR_REDIRECT_URI);
      return Response.json({access_token:'local-access',refresh_token:'local-refresh',expires_in:3600,scope:calendarScope});
    });
    const callback='/api/calendar/google/callback?state='+state+'&code=authorization-code';
    const done=await app.request(callback);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('fermer cet onglet');
    expect(await (await app.request(base+'status',{headers:{Cookie:'blok_session=bob'}})).json()).toEqual({configured:true,connected:true});
    const row=(await db.query("SELECT * FROM calendar_google_connections WHERE user_id='bob'")).rows[0];
    expect(row.refresh_secret).not.toContain('local-refresh');
    // One consent, one connection: a replayed callback is refused.
    expect((await app.request(callback)).status).toBe(400);
    expect(local).toHaveBeenCalledTimes(1);
    await db.query("DELETE FROM calendar_google_connections WHERE user_id='bob'");
  });

  it('clears a revoked account and its availability opt-in together while preserving a concurrently replaced grant',async()=>{
    const google=createGoogleCalendarProvider('secret'.repeat(8),env,http);
    const old=google.encrypt('b','alice','refresh','old-grant');
    const replacement=google.encrypt('b','alice','refresh','replacement-grant');
    await db.query(`INSERT INTO calendar_google_connections VALUES('b','alice',$1,$2,now())`,[old,google.encrypt('b','alice','access','old-access')]);
    await db.query("INSERT INTO calendar_availability_shares VALUES('b','alice')");
    const fail=()=>Response.json({error:'invalid_grant'},{status:400});
    const getBusy=()=>google.freeBusy(db,'b','alice','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
    http.mockImplementationOnce(async()=>{
      await db.query("UPDATE calendar_google_connections SET refresh_secret=$1 WHERE workspace_id='b' AND user_id='alice'",[replacement]);
      return fail();
    });
    await expect(getBusy()).rejects.toMatchObject({status:409});
    expect((await db.query("SELECT refresh_secret FROM calendar_google_connections WHERE workspace_id='b'")).rows[0].refresh_secret).toBe(replacement);
    expect((await db.query("SELECT FROM calendar_availability_shares WHERE workspace_id='b'")).rowCount).toBe(1);
    http.mockImplementationOnce(async()=>fail());
    await expect(getBusy()).rejects.toMatchObject({status:409});
    expect((await db.query("SELECT FROM calendar_google_connections WHERE workspace_id='b'")).rowCount).toBe(0);
    expect((await db.query("SELECT FROM calendar_availability_shares WHERE workspace_id='b'")).rowCount).toBe(0);
    await expect(getBusy()).rejects.toMatchObject({status:409});
  });

});
