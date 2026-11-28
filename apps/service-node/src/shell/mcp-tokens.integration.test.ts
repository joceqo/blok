import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashSecret } from '../auth/codes.ts';
import { createShellApp } from './app.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
const goUrl = process.env.SHELL_TEST_GO_MCP_URL;

function accountApi(db: pg.Pool, session: string) {
  const app = createShellApp(db,'s'.repeat(32),new Set());
  return (method:string, suffix='', body?:object) => app.request('/api/mcp/tokens'+suffix, {
    method, headers:{Cookie:'blok_session='+session}, body:body && JSON.stringify(body),
  });
}
async function seedUser(db: pg.Pool, id: string) {
  const session=randomUUID();
  await db.query("INSERT INTO users(id,email) VALUES($1,$1||'@example.test')",[id]);
  await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashSecret(session),id]);
  return session;
}

describe.skipIf(!url)('account MCP token lifecycle in the canonical schema', () => {
  const schema='mcp_'+randomUUID().replaceAll('-','');
  const owner=new pg.Pool({connectionString:url});
  const db=new pg.Pool({connectionString:url, options:'-csearch_path='+schema});
  let mine: ReturnType<typeof accountApi>, other: ReturnType<typeof accountApi>;
  beforeAll(async () => {
    await owner.query('CREATE SCHEMA '+schema);
    await db.query(await readFile(process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql',import.meta.url),'utf8'));
    mine=accountApi(db,await seedUser(db,'mine'));
    other=accountApi(db,await seedUser(db,'other'));
  });
  beforeEach(async()=>{await db.query('TRUNCATE mcp_tokens,email_rate_limits');});
  afterAll(async()=>{await db.end();await owner.query('DROP SCHEMA '+schema+' CASCADE');await owner.end();});

  it('shows the secret once, lists only active owned hashes, and rotates and revokes only owned tokens', async()=>{
    expect((await accountApi(db,'invalid')('GET')).status).toBe(401);
    expect((await mine('POST','',{label:'é'.repeat(41)})).status).toBe(400);
    const response=await mine('POST','',{label:'  CLI  '});
    expect(response.status).toBe(201);
    const issued=await response.json();
    expect(issued.label).toBe('CLI');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.id).toBe(hashSecret(issued.token));
    expect(Date.parse(issued.expiresAt)-Date.parse(issued.createdAt)).toBe(90*86400_000);
    expect((await accountApi(db,issued.token)('GET')).status).toBe(401);
    expect(await (await other('GET')).json()).toEqual({tokens:[]});
    expect((await other('POST','/'+issued.id+'/rotate')).status).toBe(404);
    expect((await other('DELETE','/'+issued.id)).status).toBe(404);
    const {token:_,...publicFields}=issued;
    expect(await (await mine('GET')).json()).toEqual({tokens:[{...publicFields,lastUsedAt:null}]});
    await db.query('UPDATE mcp_tokens SET last_used_at=now() WHERE id=$1',[issued.id]);
    const rotated=await (await mine('POST','/'+issued.id+'/rotate')).json();
    expect(rotated.label).toBe(issued.label);
    expect(rotated.id).not.toBe(issued.id);
    expect(rotated.id).toBe(hashSecret(rotated.token));
    expect((await db.query('SELECT id,last_used_at FROM mcp_tokens')).rows).toEqual([{id:rotated.id,last_used_at:null}]);
    await db.query("UPDATE mcp_tokens SET expires_at=now()-interval '1 day' WHERE id=$1",[rotated.id]);
    expect(await (await mine('GET')).json()).toEqual({tokens:[]});
    expect((await mine('POST','/'+rotated.id+'/rotate')).status).toBe(404);
    expect((await mine('DELETE','/'+rotated.id)).status).toBe(200);
  });
  it('serializes concurrent creates at ten active tokens and preserves the Go hourly counter',async()=>{
    await db.query(`INSERT INTO mcp_tokens(id,user_id,label,expires_at)
      SELECT 'prior-'||i,'mine','prior',now()+interval '1 day' FROM generate_series(1,9) i`);
    const results=await Promise.all([mine('POST','',{label:'A'}),mine('POST','',{label:'B'})]);
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);
    await db.query("UPDATE email_rate_limits SET count=9 WHERE key='mcp-token:mine'");
    expect((await mine('POST','/absent/rotate')).status).toBe(404);
    expect((await mine('POST','',{label:'Limited'})).status).toBe(429);
    await db.query("UPDATE email_rate_limits SET window_start=now()-interval '2 hours' WHERE key='mcp-token:mine'");
    expect((await mine('DELETE','/prior-1')).status).toBe(200);
    expect((await mine('POST','',{label:'New window'})).status).toBe(201);
  });
});

// Both URLs must name the same disposable database/schema. Only rows for this
// newly generated account and workspace are inserted and cleaned up.
describe.skipIf(!url || !goUrl)('Node-issued tokens against the running Go MCP endpoint',()=>{
  const db=new pg.Pool({connectionString:url});
  const id='interop-'+randomUUID();
  let session:string;
  const call=async (token:string, name='blok_list_workspaces',args:Record<string,string>={})=>{
    const result=await fetch(new URL('/mcp',goUrl),{method:'POST',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    const text=await result.text();
    const payload=text.split('\n').find(line=>line.startsWith('data: '))?.slice(6) ?? text;
    return {status:result.status,body:JSON.parse(payload)};
  };
  beforeAll(async()=>{
    session=await seedUser(db,id);
    await db.query('INSERT INTO workspaces(id,slug,name) VALUES($1,$1,$1)',[id]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$1,'viewer')",[id]);
  });
  afterAll(async()=>{
    for (const sql of ['DELETE FROM mcp_tokens WHERE user_id=$1','DELETE FROM sessions WHERE user_id=$1',
      'DELETE FROM memberships WHERE user_id=$1','DELETE FROM pages WHERE workspace_id=$1',
      'DELETE FROM workspaces WHERE id=$1','DELETE FROM users WHERE id=$1']) await db.query(sql,[id]);
    await db.query('DELETE FROM email_rate_limits WHERE key=$1',['mcp-token:'+id]);
    await db.end();
  });
  it('accepts a new token, enforces current viewer access, and immediately refuses rotated or revoked secrets',async()=>{
    const api=accountApi(db,session);
    const issued=await (await api('POST','',{label:'MCP interop'})).json();
    const live=await call(issued.token);
    expect(live.status).toBe(200);
    expect(live.body.result.content[0].text).toContain(id);
    expect((await (await api('GET')).json()).tokens[0].lastUsedAt).toBeTruthy();
    const write=await call(issued.token,'blok_create_page',{workspace:id,title:'Disallowed'});
    expect(write.body.result.isError).toBe(true);
    expect((await db.query('SELECT id FROM pages WHERE workspace_id=$1',[id])).rowCount).toBe(0);
    const rotated=await (await api('POST','/'+issued.id+'/rotate')).json();
    expect((await call(issued.token)).status).toBe(401);
    expect((await call(rotated.token)).status).toBe(200);
    expect((await api('DELETE','/'+rotated.id)).status).toBe(200);
    expect((await call(rotated.token)).status).toBe(401);
    expect((await call(session)).status).toBe(401);
  });
});
