// Opt-in verification against native release resources. Run after preparing bundled-runtime:
// node --test desktop/runtime/supervisor.smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {openAsBlob} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const resources = resolve(process.env.BLOK_TEST_RUNTIME || join(desktop, 'src-tauri/bundled-runtime'));
const web = resolve(process.env.BLOK_TEST_WEB || join(desktop, 'dist'));
const node = join(resources, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');

function launch(data) {
  const child = spawn(node, [join(resources, 'supervisor.mjs'), '--resources', resources, '--web', web, '--data', data],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal, errors }));
  const lines = createInterface({ input: child.stdout });
  const ready = Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line)),
    exited.then(({ errors }) => { throw new Error(errors || 'Supervisor stopped before ready'); })]);
  return { ready, exited, async stop() { child.stdin.end(); return exited; } };
}

function connectRoom(origin, id, ticket) {
  return new Promise((resolve, reject) => {
    const req = request(origin + '/api/blok/sync/' + id, { headers: { origin: 'tauri://localhost',
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-protocol': 'blok-sync.v2, ' + ticket } });
    req.once('upgrade', (res, socket) => { socket.destroy(); resolve(res.headers['sec-websocket-protocol']); });
    req.once('response', res => { res.resume(); reject(new Error('Room refused upgrade: ' + res.statusCode)); });
    req.once('error', reject);
    req.end();
  });
}

test('the disk importer keeps original bytes and translates rich text without dropping marks', async () => {
  const {readLegacyWorkspace} = await import(pathToFileURL(join(resources, 'app/import-disk.mjs')).href);
  const directory = await mkdtemp(join(tmpdir(), 'blok-disk-import-'));
  try {
    const page = {id:'p1', title:'Notes', parentId:null};
    await writeFile(join(directory, 'index.json'), JSON.stringify({pages:[page], trash:[], activeId:page.id}));
    await writeFile(join(directory, 'row-bodies.json'), JSON.stringify({sheet:{documentId:page.id,title:'Sheet'}}));
    const doc = {blocks:[{id:'paragraph', type:'paragraph', data:{text:[{text:'gras',marks:{bold:true}}]}}]};
    const bytes = JSON.stringify(doc);
    await writeFile(join(directory, 'p1.json'), bytes);
    const result = await readLegacyWorkspace(directory);
    assert.equal(result.active, page.id);
    assert.equal(result.pages.find(p => p.meta.id === 'sheet').meta.databaseRowBody, true);
    assert.equal(result.pages[0].meta.databaseRowBody, undefined);
    assert.equal(result.pages[0].content.blocks[0].data.text, '<strong>gras</strong>');
    assert.equal(result.files.get('p1.json').bytes.toString(), bytes);
    assert.equal(await readFile(join(directory, 'p1.json'), 'utf8'), bytes);
  } finally {
    await rm(directory, {recursive:true, force:true});
  }
});

async function deviceSession(ready) {
  const response = await fetch(ready.apiOrigin + '/internal/desktop/session', {
    method: 'POST', redirect: 'error', headers: {authorization: 'Bearer ' + ready.deviceSecret},
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('the local device account keeps its workspace and private object across a clean restart', { timeout: 220_000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'blok-desktop-runtime-'));
  let local = launch(data);
  try {
    const ready = await local.ready;
    const {origin} = ready;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(await (await fetch(origin)).text(), /<html/i);
    assert.equal((await fetch(origin + '/internal/room-access')).status, 404);
    const other = launch(data);
    await assert.rejects(other.ready, /already in use/);
    assert.notEqual((await other.exited).code, 0);
    let token;
    const call = (path, method = 'GET', payload) => fetch(origin + path, { method,
      headers: { origin: 'tauri://localhost', 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: payload ? JSON.stringify(payload) : undefined });
    assert.equal((await call('/api/instance').then(r => r.json())).setupRequired, false);
    assert.equal((await call('/internal/desktop/session', 'POST')).status, 404);
    assert.notEqual((await fetch(ready.apiOrigin + '/internal/desktop/session', {method: 'POST'})).status, 200);
    const localAccount = await deviceSession(ready);
    token = localAccount.token;
    assert.ok(token);
    const workspace = localAccount.workspaces.find(w => w.id === localAccount.deviceWorkspaceId);
    assert.ok(workspace);
    assert.equal(workspace.role, 'admin');
    const base = '/api/workspaces/' + workspace.slug;
    // First attachment can arrive while the object store still starts.
    const image = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
    const upload = await call(base + '/images', 'POST', { dataUrl: 'data:image/gif;base64,' + image.toString('base64') });
    assert.equal(upload.status, 201);
    const { url } = await upload.json();
    assert.match(url, /^\/files\//);
    assert.ok((await fetch(origin + url)).status >= 400);
    assert.deepEqual(Buffer.from(await (await call(url)).arrayBuffer()), image);
    const page = { id: 'native-page', title: 'Native', parentId: null };
    assert.equal((await call(base + '/index', 'PUT', { revision: 0, pages: [page], trash: [] })).status, 200);
    const { ticket } = await (await call(base + '/ticket?doc=' + page.id)).json();
    assert.ok(ticket);
    const form = new FormData();
    form.append('file', new Blob([image], {type: 'image/gif'}), 'capture.gif');
    const saved = await fetch(origin + '/api/blok/upload', {
      method: 'POST', headers: {origin: 'tauri://localhost', authorization: 'Bearer ' + ticket}, body: form,
    });
    assert.equal(saved.headers.get('access-control-allow-origin'), 'tauri://localhost');
    assert.equal(saved.status, 200, await saved.clone().text());
    const fileUrl = (await saved.json()).url;
    const signed = await call('/api/assets/url?url=' + encodeURIComponent(fileUrl));
    assert.equal(signed.status, 200);
    assert.deepEqual(Buffer.from(await (await fetch((await signed.json()).url)).arrayBuffer()), image);
    assert.equal(await connectRoom(origin, page.id, ticket), 'blok-sync.v2');
    const videoBytes=process.env.BLOK_TEST_BACKUP_VIDEO ? 600*1024*1024 : 4096;
    {
      const video=join(data,'capture.mp4');
      const source=await open(video,'wx');
      try {await source.truncate(videoBytes);}finally{await source.close();}
      const form=new FormData();
      form.append('file',await openAsBlob(video,{type:'video/mp4'}),'capture.mp4');
      const uploaded=await fetch(origin+'/api/blok/upload',{method:'POST',headers:{origin:'tauri://localhost',authorization:'Bearer '+ticket},body:form});
      if(!uploaded.ok) console.error((await readFile(join(data,'runtime.log'),'utf8')).slice(-3000));
      assert.equal(uploaded.status,200,await uploaded.clone().text());
      assert.equal((await uploaded.json()).size,videoBytes);
    }
    const authored=await call(base+'/import/markdown','POST',{attempt:crypto.randomUUID(),name:'Carnet.md',source:'Phrase conservée après restauration.'});
    assert.equal(authored.status,200,await authored.clone().text());
    const {runWorkspaceBackup} = await import(pathToFileURL(join(resources, 'app/backup.mjs')));
    const settings = {workspace:workspace.id,kind:'folder',action:'save'};
    const copy = await runWorkspaceBackup(data, resources, settings, async () => data);
    const snapshot = JSON.parse(await readFile(join(copy.location,'workspace.json'),'utf8'));
    assert.equal(snapshot.workspace.id, workspace.id);
    assert.ok(snapshot.pages.some(p=>p.id===page.id));
    assert.equal(snapshot.assets.length,3);
    const recovered=await runWorkspaceBackup(data, resources, {...settings,action:'restore'}, async()=>copy.location);
    const restored=(await deviceSession(ready)).workspaces.find(w=>w.id===recovered.workspace);
    assert.ok(restored);
    const restoredIndex=await call('/api/workspaces/'+restored.slug+'/index').then(r=>r.json());
    assert.ok(restoredIndex.pages.some(p=>p.title===page.title && p.id!==page.id));
    const otherData=await mkdtemp(join(tmpdir(),'blok-backup-restore-'));
    const fresh=launch(otherData);
    try {
      const otherReady=await fresh.ready;
      await deviceSession(otherReady);
      const destination=await runWorkspaceBackup(otherData,resources,{...settings,action:'restore'},async()=>copy.location);
      const access=await deviceSession(otherReady);
      assert.ok(access.workspaces.some(w=>w.id===destination.workspace));
      const verify=await runWorkspaceBackup(otherData,resources,{...settings,workspace:destination.workspace},async()=>otherData);
      const readback=JSON.parse(await readFile(join(verify.location,'workspace.json'),'utf8'));
      assert.deepEqual(readback.assets.map(a=>a.digest).sort(),snapshot.assets.map(a=>a.digest).sort());
      assert.ok(readback.pages.some(p=>p.metadata.title===page.title));
      const note=readback.pages.find(p=>JSON.stringify(p.content).includes('Phrase conservée'));
      assert.ok(note);
      const recoveredSpace=access.workspaces.find(w=>w.id===destination.workspace);
      const body=await fetch(otherReady.origin+'/api/workspaces/'+recoveredSpace.slug+'/pages/'+note.id,{headers:{authorization:'Bearer '+access.token}});
      assert.equal(body.status,200);
      assert.match(await body.text(),/Phrase conservée/);
    }finally{await fresh.stop();await rm(otherData,{recursive:true,force:true});}
    if(!process.env.BLOK_TEST_BACKUP_VIDEO) {
      const conf=JSON.parse(await readFile(join(data,'instance.json'),'utf8'));
      const bucket={...settings,kind:'s3',url:'http://127.0.0.1:'+conf.ports.s3,bucket:'blok-assets',region:'us-east-1',
        prefix:'smoke-backups',user:conf.secrets.accessKey,token:conf.secrets.secretKey};
      const published=await runWorkspaceBackup(data,resources,bucket);
      assert.match(published.location,/^smoke-backups\//);
      const cloned=await runWorkspaceBackup(data,resources,{...bucket,action:'restore'});
      assert.ok((await deviceSession(ready)).workspaces.some(w=>w.id===cloned.workspace));
    }
    if(process.env.BLOK_TEST_GIT_REMOTE) {
      const remote={...settings,kind:'git',url:process.env.BLOK_TEST_GIT_REMOTE};
      await runWorkspaceBackup(data,resources,remote);
      await runWorkspaceBackup(data,resources,remote);
      const cloned=await runWorkspaceBackup(data,resources,{...remote,action:'restore'});
      assert.ok((await deviceSession(ready)).workspaces.some(w=>w.id===cloned.workspace));
    }
    const asset=snapshot.assets[0];
    await writeFile(join(copy.location,'attachments',asset.name),'corrupt');
    await assert.rejects(runWorkspaceBackup(data,resources,{...settings,action:'restore'},async()=>copy.location),/incomplète/);
    const config = JSON.parse(await readFile(join(data, 'instance.json'), 'utf8'));
    assert.equal((await fetch('http://127.0.0.1:' + config.ports.s3 + '/blok-assets/' + url.slice(7))).status, 403);
    assert.equal((await local.stop()).code, 0);
    local = launch(data);
    const reopened = await local.ready;
    assert.equal(reopened.origin, origin);
    const sameAccount = await deviceSession(reopened);
    assert.equal(sameAccount.user.id, localAccount.user.id);
    assert.equal(sameAccount.deviceWorkspaceId, workspace.id);
    token = sameAccount.token;
    assert.equal((await call('/api/session')).status, 200);
    const afterRestart = await call('/api/assets/url?url=' + encodeURIComponent(fileUrl));
    assert.equal(afterRestart.status, 200);
    assert.deepEqual(Buffer.from(await (await fetch((await afterRestart.json()).url)).arrayBuffer()), image);
    const range = await fetch(origin + url, { headers: { authorization: 'Bearer ' + token, range: 'bytes=0-5' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), image.subarray(0, 6));
  } finally {
    await local.stop();
    await rm(data, { recursive: true, force: true });
  }
});
