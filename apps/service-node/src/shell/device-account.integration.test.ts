import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShellApp } from './app.ts';
import { inTransaction } from './bootstrap.ts';
import { ensureDeviceAccount } from './device-account.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
const deviceSecret = 'a'.repeat(64);
const internal = 'b'.repeat(64);
describe.skipIf(!url)('embedded account on PostgreSQL', () => {
  let owner: pg.Pool, db: pg.Pool, schema: string;
  beforeEach(async () => {
    schema = 'device_' + randomUUID().replaceAll('-', '');
    owner = new pg.Pool({connectionString: url});
    await owner.query('CREATE SCHEMA ' + schema);
    db = new pg.Pool({connectionString: url, options: '-csearch_path=' + schema});
    await db.query(await readFile(new URL('../../../service/schema.sql',import.meta.url),'utf8'));
    vi.stubEnv('BLOK_DEVICE_SESSION_SECRET', deviceSecret);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.end();
    try { await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
    finally { await owner.end(); }
  });
  it('provisions once before startup and grants sessions only through the private native credential', async () => {
    const users = await Promise.all(Array.from({length:4}, () => inTransaction(db,ensureDeviceAccount)));
    expect(new Set(users).size).toBe(1);
    const app = createShellApp(db,internal,new Set());
    const instance = await (await app.request('/api/instance')).json();
    expect(instance.setupRequired).toBe(false);
    expect((await app.request('/api/setup/claim', {method:'POST'})).status).toBe(409);
    const session = (key: string, origin?: string) => app.request('/internal/desktop/session', {method:'POST',
      headers:{authorization:'Bearer ' + key, ...(origin ? {origin} : {})}});
    expect((await session('')).status).toBe(403);
    expect((await session(internal)).status).toBe(403);
    expect((await session(deviceSecret,'https://example.org')).status).toBe(403);
    expect((await app.request('/internal/room-access',{headers:{authorization:'Bearer '+deviceSecret}})).status).toBe(401);
    const response = await session(deviceSecret);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({user:{id:users[0],name:'Profil local',email:'',instanceAdmin:true},deviceWorkspaceId:body.workspaces[0].id,
      workspaces:[{slug:'local',role:'admin'}]});
    const current = await app.request('/api/session', {headers:{authorization:'Bearer ' + body.token}});
    expect(await current.json()).toMatchObject({user:body.user,deviceWorkspaceId:body.deviceWorkspaceId});
    const simultaneous = await Promise.all(Array.from({length:6}, async () => (await (await session(deviceSecret)).json()).token));
    expect(new Set(simultaneous)).toEqual(new Set([body.token]));
    expect((await db.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n).toBe(1);
    await db.query('DELETE FROM sessions WHERE user_id=$1',[users[0]]);
    const renewed = await (await session(deviceSecret)).json();
    expect(renewed.token).not.toBe(body.token);
    expect(renewed.user.id).toBe(users[0]);
  });
  it('keeps a previous password owner, default workspace, and its content separate', async () => {
    await db.query(`INSERT INTO users(id,email,name) VALUES('old','existing@example.test','Alice');
      INSERT INTO workspaces(id,slug,name) VALUES('existing','local','Existing');
      INSERT INTO memberships VALUES('existing','old','admin'); INSERT INTO instance_admins(user_id) VALUES('old');
      UPDATE instance_settings SET setup_completed_at=now(), default_workspace_id='existing';
      INSERT INTO pages(id,workspace_id,metadata) VALUES('doc','existing','{"title":"My page"}');`);
    const id = await inTransaction(db,ensureDeviceAccount);
    expect(id).not.toBe('old');
    const app = createShellApp(db,internal,new Set());
    const result = await app.request('/internal/desktop/session', {method:'POST', headers:{authorization:'Bearer '+deviceSecret}});
    expect(result.status).toBe(200);
    const session = await result.json();
    expect(session.user.instanceAdmin).toBe(false);
    expect(session.workspaces).toHaveLength(1);
    expect(session.workspaces[0].slug).not.toBe('local');
    expect((await db.query('SELECT default_workspace_id FROM instance_settings')).rows[0].default_workspace_id).toBe('existing');
    expect((await db.query("SELECT metadata->>'title' AS title FROM pages WHERE id='doc'")).rows[0].title).toBe('My page');
    vi.stubEnv('BLOK_DEVICE_SESSION_SECRET', undefined);
    const hosted = createShellApp(db,internal,new Set());
    expect((await hosted.request('/internal/desktop/session', {method:'POST',headers:{authorization:'Bearer '+internal}})).status).toBe(404);
  });
});
