// Opt-in verification against native release resources. Run after preparing bundled-runtime:
// node --test desktop/runtime/supervisor.smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const ready = Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line).origin),
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

test('native self-host keeps its origin, workspace, session and private object across a clean restart', { timeout: 220_000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'blok-desktop-runtime-'));
  let local = launch(data);
  try {
    const origin = await local.ready;
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
    const account = { email: 'native@example.test', password: randomBytes(18).toString('hex') };
    assert.equal((await call('/api/setup/claim', 'POST', { ...account, name: 'Owner', workspace: { name: 'Native', slug: 'native' } })).status, 200);
    const login = await call('/api/auth/password', 'POST', { ...account, client: 'desktop' });
    assert.equal(login.headers.get('access-control-allow-origin'), 'tauri://localhost');
    token = (await login.json()).token;
    assert.ok(token);
    const base = '/api/workspaces/native';
    const page = { id: 'native-page', title: 'Native', parentId: null };
    assert.equal((await call(base + '/index', 'PUT', { revision: 0, pages: [page], trash: [] })).status, 200);
    const { ticket } = await (await call(base + '/ticket?doc=' + page.id)).json();
    assert.ok(ticket);
    assert.equal(await connectRoom(origin, page.id, ticket), 'blok-sync.v2');
    const image = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
    const upload = await call(base + '/images', 'POST', { dataUrl: 'data:image/gif;base64,' + image.toString('base64') });
    assert.equal(upload.status, 201);
    const { url } = await upload.json();
    assert.match(url, /^\/files\//);
    assert.ok((await fetch(origin + url)).status >= 400);
    assert.deepEqual(Buffer.from(await (await call(url)).arrayBuffer()), image);
    const config = JSON.parse(await readFile(join(data, 'instance.json'), 'utf8'));
    assert.equal((await fetch('http://127.0.0.1:' + config.ports.s3 + '/blok-assets/' + url.slice(7))).status, 403);
    assert.equal((await local.stop()).code, 0);
    local = launch(data);
    assert.equal(await local.ready, origin);
    assert.equal((await call('/api/session')).status, 200);
    const range = await fetch(origin + url, { headers: { authorization: 'Bearer ' + token, range: 'bytes=0-5' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), image.subarray(0, 6));
  } finally {
    await local.stop();
    await rm(data, { recursive: true, force: true });
  }
});
