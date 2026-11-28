import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostedAi } from './hosted-ai.ts';
import { editorRequest } from './ai-editor.ts';
import { openAiKey, sealAiKey } from './ai-crypto.ts';

it('binds encrypted credentials to their original scope and refuses unoffered editor tools',() => {
  const key = randomBytes(32), saved = sealAiKey(key,'personal:one','test-provider-key');
  expect(openAiKey(key,'personal:one',saved)).toBe('test-provider-key');
  expect(() => openAiKey(key,'personal:two',saved)).toThrow();
  expect(editorRequest({model:'gpt-test',instructions:'',input:[{role:'user',content:'test'}],tools:[{
    name:'unknown',type:'function',parameters:{type:'object'},description:'test',
  }]})).toBe(false);
});

const url = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('hosted AI against the canonical schema',() => {
  const schema = 'ai_'+randomUUID().replaceAll('-','');
  const admin = new pg.Pool({connectionString:url}), db = new pg.Pool({connectionString:url,options:'-csearch_path='+schema});
  const key = randomBytes(32);
  const requests: {url:string; headers:Headers; payload:any}[] = [];
  const provide: typeof fetch = async(url,init) => {
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({url:String(url),headers:new Headers(init?.headers),payload});
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(String(url).endsWith('models')
      ? {data:[{id:'gpt-test'},{id:'gpt-audio'},{id:'gpt-test'}]}
      : {status:'completed',model:'gpt-test',usage:{input_tokens:12,input_tokens_details:{cached_tokens:2},output_tokens:5,total_tokens:17},output:payload.tools
        ? [{type:'function_call',arguments:'{}',call_id:'one',name:'blok_read'}]
        : [{type:'message',content:[{type:'output_text',text:'bonjour'}]}]});
  };
  const app = new Hono().route('/api/workspaces/:slug/ai',createHostedAi(db,provide,async() => key));
  const api = (user:string,path:string,method='GET',body?:object) =>
    app.request('/api/workspaces/demo/ai'+path,{method,headers:{Authorization:'Bearer '+user},body:body && JSON.stringify(body)});
  beforeAll(async() => {
    await admin.query('CREATE SCHEMA '+schema);
    await db.query(await readFile(process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql',import.meta.url),'utf8'));
    await db.query("INSERT INTO workspaces(id,slug,name) VALUES ('space','demo','Demo')");
    for (const [user,role] of [['alice','admin'],['bob','viewer']]) {
      await db.query('INSERT INTO users(id,email) VALUES($1,$1 || \'@test\')',[user]);
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[createHash('sha256').update(user!).digest('hex'),user]);
      await db.query("INSERT INTO memberships VALUES('space',$1,$2)",[user,role]);
    }
  });
  afterAll(async() => { await db.end(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end(); });
  it('uses the shared and personal credentials with the shell contract',async() => {
    expect((await api('unknown','')).status).toBe(401);
    expect((await api('bob','/credentials','PUT',{scope:'workspace',apiKey:'secret-test'})).status).toBe(403);
    expect((await api('alice','/credentials','PUT',{scope:'workspace',apiKey:'secret-shared',model:'gpt-test'})).status).toBe(200);
    expect(await (await api('bob','')).json()).toMatchObject({effective:{source:'workspace',model:'gpt-test'},canManageWorkspace:false});
    expect((await api('bob','/models?scope=workspace')).status).toBe(403);
    expect(await (await api('bob','/models')).json()).toEqual({models:[{id:'gpt-test'}],source:'workspace'});
    expect(requests.at(-1)?.headers.get('Authorization')).toBe('Bearer secret-shared');
    expect((await api('bob','/credentials','PUT',{scope:'personal',apiKey:'secret-bob',model:'gpt-test'})).status).toBe(200);
    expect(await (await api('bob','/respond','POST',{messages:[{role:'user',content:'test'}]})).json()).toEqual({text:'bonjour',model:'gpt-test',source:'personal'});
    expect(requests.at(-1)?.headers.get('Authorization')).toBe('Bearer secret-bob');
    expect(requests.at(-1)?.payload.store).toBe(false);
    const edit = {model:'gpt-test',instructions:'',input:[{role:'user',content:'test'}],tools:[{name:'blok_read',type:'function',parameters:{type:'object'},description:'read'}]};
    expect(await (await api('bob','/editor-respond','POST',edit)).json()).toMatchObject({output:[{name:'blok_read'}]});
    const day = new Date().toISOString().slice(0,10);
    const usage = '/usage?end='+day+'&days=7';
    expect(await (await api('bob',usage)).json()).toMatchObject({rows:[
      {day,feature:'chat',model:'gpt-test',calls:1,tokens:17,measured:1,input:12,cached:2,output:5,detailed:1},
      {day,feature:'edit',calls:1,tokens:17,measured:1},
    ]});
    expect(await (await api('alice',usage)).json()).toEqual({rows:[]});
    expect((await api('unknown',usage)).status).toBe(401);
    expect((await api('bob','/usage?days=7&end=2026-02-30')).status).toBe(400);
    expect((await api('bob','/editor-respond','POST',{...edit,tools:[]})).status).toBe(502);
    const content = [{type:'input_text',text:'Que vois-tu ?'},{type:'input_image',image_url:'data:image/png;base64,YWJj'}];
    expect((await api('bob','/respond','POST',{messages:[{role:'user',content}]})).status).toBe(200);
    expect(requests.at(-1)?.payload.input).toEqual([{role:'user',content}]);
    const external = [content[0],{type:'input_image',image_url:'https://example.com/photo.png'}];
    expect((await api('bob','/respond','POST',{messages:[{role:'user',content:external}]})).status).toBe(400);
    expect((await api('bob','/credentials?scope=personal','DELETE')).status).toBe(200);
    expect(await (await api('bob','')).json()).toMatchObject({effective:{source:'workspace'}});
  });
});
