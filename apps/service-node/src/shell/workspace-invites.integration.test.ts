import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShellApp } from './app.js';

const databaseUrl = process.env.SHELL_TEST_DATABASE_URL;
const schemaPath = process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url);
describe.skipIf(!databaseUrl)('canonical workspace invitations', () => {
  const schema = 'test_invites_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({connectionString: databaseUrl});
  const db = new pg.Pool({connectionString: databaseUrl, options:'-csearch_path=' + schema});
  const deliver = vi.fn(async (_id: string, _message: string) => {});
  const mail = { normalize: async (email: string) => email.trim().toLowerCase(), deliver };
  const app = createShellApp(db, 's'.repeat(32), new Set(), async () => {}, mail);
  function call(user: string, method = 'GET', suffix = '', input?: object, workspace = 'alpha') {
    return app.request('/api/workspaces/' + workspace + '/invites' + suffix, { method,
      headers:{ Authorization: 'Bearer '+user }, body:input && JSON.stringify(input) });
  }
  const newInvite = (role = 'viewer') => call('owner','POST','',{email:' MEMBER@SITE.TEST ',role,message:'Bienvenue 🍋'});
  async function rows() {
    return (await db.query('SELECT * FROM invites ORDER BY id')).rows;
  }
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(schemaPath,'utf8'));
    await db.query(`INSERT INTO users(id,email) VALUES('owner','o@site'),('reader','r@site'),('plain','p@site');
      INSERT INTO workspaces(id,slug,name) VALUES('w','alpha','Alpha'),('second','beta','Beta');
      INSERT INTO memberships VALUES('w','owner','admin'),('w','reader','viewer'),('w','plain','member'),('second','owner','admin')`);
    for (const user of ['owner','reader','plain']) {
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 day')",
        [createHash('sha256').update(user).digest('hex'),user]);
    }
  });
  beforeEach(async () => { deliver.mockReset(); await db.query('TRUNCATE invites,email_rate_limits'); });
  afterAll(async () => { await db.end(); try { await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE'); } finally { await admin.end(); } });

  it('stages delivery before admission, then lists a normalized seven-day invitation and supports revocation', async () => {
    deliver.mockImplementationOnce(async (id, message) => {
      const [staged] = await rows();
      expect(staged).toMatchObject({id,email:'member@site.test',workspace_id:'w',role:'viewer',status:'delivering'});
      expect(staged).not.toHaveProperty('message');
      expect(message).toBe('Bienvenue 🍋');
      expect((await db.query("SELECT id FROM invites WHERE email=$1 AND status='pending'",[staged.email])).rowCount).toBe(0);
    });
    expect((await newInvite()).status).toBe(201);
    const listed = await (await call('owner')).json();
    expect(listed.invites).toHaveLength(1);
    const invite = listed.invites[0];
    expect(invite).toMatchObject({role:'viewer',status:'pending',email:'member@site.test'});
    expect(Date.parse(invite.expiresAt)-Date.now()).toBeCloseTo(7*86400000,-4);
    expect((await call('owner','DELETE','/'+invite.id,undefined,'beta')).status).toBe(404);
    expect((await call('owner','DELETE','/'+invite.id)).status).toBe(200);
    expect((await call('owner','DELETE','/'+invite.id)).status).toBe(404);
  });
  it('allows only an authenticated workspace administrator to list, create or revoke', async () => {
    for (const [user,status] of [['missing',401],['reader',403],['plain',403]] as const) {
      for (const [method,suffix] of [['GET',''],['POST',''],['DELETE','/id']] as const) {
        expect((await call(user,method,suffix,method==='POST'?{email:'a@site'}:undefined)).status).toBe(status);
      }
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
  it('does not admit an undelivered address or exceed the existing hourly quota', async () => {
    deliver.mockRejectedValueOnce(new Error('mail unavailable'));
    expect((await newInvite()).status).toBe(503);
    expect((await rows())[0].status).toBe('delivery-failed');
    await db.query("UPDATE email_rate_limits SET count=30 WHERE key='invite:owner'");
    expect((await newInvite()).status).toBe(429);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });
  it('keeps a concurrent revocation after the mailer finishes', async () => {
    deliver.mockImplementationOnce(async id => {
      expect((await call('owner','DELETE','/'+id)).status).toBe(200);
    });
    expect((await newInvite()).status).toBe(409);
    expect((await rows())[0].status).toBe('revoked');
  });
});
