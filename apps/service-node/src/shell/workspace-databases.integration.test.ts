import {afterAll,beforeAll,expect,it,describe,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {Hono} from 'hono';
import {createWorkspaceSearch} from './workspace-search.ts';
import {createHostedMcp} from './hosted-mcp.ts';
import {hashSecret} from '../auth/codes.ts';

const url=process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('chat and MCP database reading',()=>{
  const schema='dbread_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:url}), pool=new pg.Pool({connectionString:url,options:'-csearch_path='+schema});
  const app=new Hono().route('/s/:slug',createWorkspaceSearch(pool)).route('/mcp',createHostedMcp(pool));
  const chat=(input:object)=>app.request('/s/demo/databases',{method:'POST',headers:{authorization:'Bearer human','content-type':'application/json'},body:JSON.stringify(input)});
  const rpc=async(method:string,params:object)=>{
    const res=await app.request('/mcp',{method:'POST',headers:{authorization:'Bearer robot','content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    const text=await res.text();expect(res.status).toBe(200);
    return JSON.parse(text.split('\n').find(s=>s.startsWith('data: '))?.slice(6) ?? text).result;
  };
  beforeAll(async()=>{
    vi.stubEnv('PUBLIC_URL','http://127.0.0.1:17777');vi.stubEnv('TICKET_SECRET','a'.repeat(40));
    await admin.query('CREATE SCHEMA '+schema);
    await pool.query(await readFile(new URL('../../../service/schema.sql',import.meta.url),'utf8'));
    await pool.query("INSERT INTO workspaces(id,slug,name) VALUES('w','demo','Demo')");
    await pool.query("INSERT INTO users(id,email) VALUES('viewer','viewer@test')");
    await pool.query("INSERT INTO memberships VALUES('w','viewer','viewer')");
    await pool.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,'viewer',now()+interval '1 hour')",[hashSecret('human')]);
    await pool.query("INSERT INTO mcp_tokens(id,user_id,label,expires_at) VALUES($1,'viewer','test',now()+interval '1 hour')",[hashSecret('robot')]);
    const doc={blocks:[{id:'db',type:'database',data:{title:'Pièces',schema:[{id:'s',name:'État',type:'status',config:{options:[{id:'wait',label:'En attente'},{id:'ok',label:'Rendu'}]}}]}},
      ...Array.from({length:84},(_,i)=>({type:'database-row',id:'r'+i,parent:'db',data:{title:'Pièce '+i,template:i===83,properties:{s:i===82?'ok':'wait'}}}))]};
    for(const [id,visibility] of [['p','workspace'],['hidden','private']]) await pool.query("INSERT INTO pages(id,workspace_id,metadata,content,visibility) VALUES($1,'w',$2,$3,$4)",[id,{title:id},doc,visibility]);
  });
  afterAll(async()=>{vi.unstubAllEnvs();await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
  it('advertises the tools, applies identical filters and pagination on both transports, and rechecks access',async()=>{
    expect((await rpc('tools/list',{})).tools.map((t:{name:string})=>t.name)).toContain('blok_query_database');
    const catalog=await (await chat({action:'list'})).json();
    expect(catalog.databases.map((d:{page:string})=>d.page)).toEqual(['p']);
    const args={page:'p',database:'db',filters:[{column:'s',value:'En attente'}]};
    const first=await (await chat({action:'query',...args})).json();expect(first.total).toBe(82);expect(first.rows).toHaveLength(50);
    const call=(q:object)=>rpc('tools/call',{name:'blok_query_database',arguments:{workspace:'demo',...q}});
    expect(JSON.parse((await call(args)).content[0].text)).toEqual(first);
    const tail=JSON.parse((await call({...args,offset:50})).content[0].text);
    expect(tail.rows).toHaveLength(32);expect(tail.nextOffset).toBeUndefined();
    expect((await call({...args,page:'hidden'})).isError).toBe(true);
    await pool.query("UPDATE pages SET visibility='private' WHERE id='p'");
    expect((await chat({action:'query',...args})).status).toBe(404);
    expect((await call(args)).isError).toBe(true);
  });
});
