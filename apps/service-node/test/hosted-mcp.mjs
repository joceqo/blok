// Run against a disposable PostgreSQL instance after building the product, room and MCP bundles.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createShellApp } from '../dist/shell/app.js';

const host = process.env.SHELL_TEST_DATABASE_URL;
if (!host) throw new Error('Set SHELL_TEST_DATABASE_URL to a disposable PostgreSQL URL');
const {startAllRooms,shellRoomTickets} = await import(process.env.SHELL_TEST_ROOM_BUNDLE
  ? pathToFileURL(resolve(process.env.SHELL_TEST_ROOM_BUNDLE)).href
  : new URL('../../../packages/server/node/dist/journal-room.mjs',import.meta.url).href);
const schema = 'mcp_'+randomUUID().replaceAll('-','');
const root = new pg.Pool({connectionString:host}), db = new pg.Pool({connectionString:host,options:'-csearch_path='+schema});
const dir = await mkdtemp(join(tmpdir(),'blok-mcp-'));
const secret = 'test-only-secret'.repeat(3);
process.env.TICKET_SECRET = secret;
process.env.BLOK_NODE_ROOM_ALL = '1';
const app = createShellApp(db,secret,new Set());
let room,server;
async function rpc(token,method,params,headers={}) {
  const res = await fetch(process.env.PUBLIC_URL+'/mcp',{method:'POST',headers:{
    Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const raw = await res.text();
  const payload = raw.split('\n').find(line=>line.startsWith('data: '))?.slice(6) ?? raw;
  return {status:res.status,body:JSON.parse(payload)};
}
const call = async(token,name,args={}) => (await rpc(token,'tools/call',{name,arguments:args})).body.result;
const digest = token => createHash('sha256').update(token).digest('hex');

try {
  await root.query('CREATE SCHEMA '+schema);
  await db.query(await readFile(new URL('../../service/schema.sql',import.meta.url),'utf8'));
  const writer = randomUUID(), reader = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,name) VALUES('space','demo','Demo')");
  for (const [id,token,role] of [['writer',writer,'member'],['reader',reader,'viewer']]) {
    await db.query("INSERT INTO users(id,email) VALUES($1,$1||'@test')",[id]);
    await db.query("INSERT INTO memberships VALUES('space',$1,$2)",[id,role]);
    await db.query("INSERT INTO mcp_tokens(id,user_id,label,expires_at) VALUES($1,$2,'agent',now()+interval '1 hour')",[digest(token),id]);
  }
  await new Promise(resolveReady => {
    server = serve({fetch:app.fetch,hostname:'127.0.0.1',port:0}, info => {
      process.env.PUBLIC_URL='http://127.0.0.1:'+info.port;
      resolveReady();
    });
  });
  const startRoom = () => startAllRooms({directory:dir,allowedOrigins:new Set([process.env.PUBLIC_URL]),
    authorize:shellRoomTickets(process.env.PUBLIC_URL,secret),projection:{origin:process.env.PUBLIC_URL,secret}});
  room = await startRoom();
  process.env.MCP_SYNC_URL=room.url;
  process.env.BLOK_ROOM_STATE_ORIGIN=new URL(room.url.replace('ws:','http:')).origin;
  assert.equal((await rpc('unknown','tools/list',{})).status,401);
  assert.equal((await rpc(writer,'tools/list',{},{Origin:'http://localhost'})).status,401);
  assert.equal((await fetch(process.env.PUBLIC_URL+'/api/session',{headers:{Authorization:'Bearer '+writer}})).status,401);
  const tools = (await rpc(writer,'tools/list',{})).body.result.tools.map(t=>t.name);
  for (const name of ['blok_list_workspaces','blok_list_pages','blok_upload_image','blok_open','blok_execute','blok_read','blok_close']) assert.ok(tools.includes(name),name);
  const created = JSON.parse((await call(writer,'blok_create_page',{workspace:'demo',title:'From MCP'})).content[0].text);
  assert.ok(created.id);
  assert.ok((await call(reader,'blok_list_pages',{workspace:'demo'})).content[0].text.includes('From MCP'));
  assert.equal((await call(reader,'blok_create_page',{workspace:'demo',title:'Denied'})).isError,true);
  assert.equal((await call(reader,'blok_open',{documentId:created.id,write:true})).structuredContent.error.code,'FORBIDDEN');
  const open = (await call(writer,'blok_open',{documentId:created.id,write:true})).structuredContent;
  assert.equal(open.mode,'live',JSON.stringify(open));
  assert.equal(open.durability,'acknowledged');
  const handle = open.handle;
  const commands = [{name:'block.insert',args:{type:'paragraph',id:'agent-edit',data:{text:[{text:'saved via MCP'}]}}}];
  const executed = (await call(writer,'blok_execute',{handle,commands})).structuredContent;
  assert.ok(executed.delivery?.durable,JSON.stringify(executed));
  assert.match(JSON.stringify((await db.query('SELECT content FROM pages WHERE id=$1',[created.id])).rows[0].content),/saved via MCP/);
  assert.ok((await call(reader,'blok_read',{handle})).isError);
  // Duplicate a live private source as a member who only holds a read share on it.
  // The source stays resident during the HTTP /state request.
  const copier = randomUUID();
  await db.query("INSERT INTO users(id,email) VALUES('copier','copier@test')");
  await db.query("INSERT INTO memberships VALUES('space','copier','member')");
  await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,'copier',now()+interval '1 hour')",[digest(copier)]);
  await db.query("UPDATE pages SET visibility='private' WHERE id=$1",[created.id]);
  await db.query(`INSERT INTO pages(id,workspace_id,metadata,visibility) VALUES
    ('parent','space','{"id":"parent","title":"Parent"}','private')`);
  const duplicate = (parentId) => fetch(process.env.PUBLIC_URL+'/api/workspaces/demo/pages/'+created.id+'/duplicate',{
    method:'POST',headers:{Authorization:'Bearer '+copier,'Content-Type':'application/json'},
    body:JSON.stringify({id:'copy',title:'Copied from Node',parentId}),
  });
  assert.equal((await duplicate(null)).status,404);
  await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,'copier','view','writer'),('parent','copier','view','writer')",[created.id]);
  assert.equal((await duplicate('parent')).status,404);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM pages WHERE id='copy'")).rows[0].n,0);
  assert.equal((await db.query("SELECT revision::int FROM workspaces WHERE id='space'")).rows[0].revision,created.revision);
  await db.query("UPDATE page_shares SET level='edit' WHERE page_id='parent' AND user_id='copier'");
  const copied = await duplicate('parent');
  assert.equal(copied.status,201,await copied.clone().text());
  assert.deepEqual(await copied.json(),{id:'copy',revision:created.revision+1});
  const original = (await db.query('SELECT content FROM pages WHERE id=$1',[created.id])).rows[0].content;
  const {rows:[copy]} = await db.query(`SELECT content,metadata,visibility,(SELECT level FROM page_shares
    WHERE page_id='copy' AND user_id='copier') AS grant FROM pages WHERE id='copy'`);
  assert.deepEqual(copy.content,{...original,title:'Copied from Node'});
  assert.equal(copy.metadata.parentId,'parent');
  assert.equal(copy.visibility,'private');
  assert.equal(copy.grant,'full');
  console.log('Live duplication used the separate Node room snapshot and preserved private content, parent permissions, editor grant and revision.');
  const close = await call(writer,'blok_close',{handle});
  assert.ok(!close.isError);
  // Reopen the journal in a fresh room instance with a page reader's ticket.
  await room.close();
  room = await startRoom();
  const issued = await fetch(process.env.PUBLIC_URL+'/api/workspaces/demo/ticket?doc='+created.id,
    {headers:{Authorization:'Bearer '+copier}});
  assert.equal(issued.status,200);
  const {ticket} = await issued.json();
  const history = (suffix='') => fetch(room.url.replace('ws:','http:')+created.id+'/history'+suffix,
    {headers:{Authorization:'Bearer '+ticket,Origin:process.env.PUBLIC_URL}});
  const response = await history();
  assert.equal(response.status,200,await response.clone().text());
  const timeline = await response.json();
  const publicId = 'actor-'+digest('mcp:'+digest(writer)).slice(0,16);
  const note = {id:publicId,kind:'agent',onBehalfOf:'writer'};
  const version = timeline.versions.find(v=>v.actorKinds.some(a=>a.id===publicId));
  assert.ok(version,JSON.stringify(timeline));
  assert.deepEqual(version.actorKinds,[note]);
  for (const path of ['/'+version.lineage+'/'+version.sequence+'/changes?since=0','/changes']) {
    const details = await (await history(path)).json();
    const row = details.changes.find(r=>r.actor===publicId);
    assert.deepEqual(row?.actors,[note]);
    assert.ok(!JSON.stringify(details).includes(digest(writer)));
  }
  const inserted = original.blocks.find(block => block.id === 'agent-edit');
  assert.equal(inserted.createdBy,'writer');
  assert.equal(inserted.createdWith,publicId);
  assert.ok(!JSON.stringify(original).includes(digest(writer)));
  await db.query("DELETE FROM page_shares WHERE page_id=$1 AND user_id='copier'",[created.id]);
  assert.equal((await history()).status,403);
  console.log('Verified durable MCP actor and delegating account in versions, sequence and time ranges after restart. Revoked reader denied.');
  await db.query('DELETE FROM mcp_tokens WHERE id=$1',[digest(writer)]);
  assert.equal((await rpc(writer,'tools/list',{})).status,401);
  console.log('Node MCP HTTP and journal verified: bearer isolation, workspace tools, read/write permissions, durable editor command, token revocation.');
} finally {
  await room?.close();
  if (server) await new Promise(done => { server.close(done); server.closeAllConnections(); });
  await db.end();
  await root.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
  await root.end();
  await rm(dir,{recursive:true,force:true});
}
