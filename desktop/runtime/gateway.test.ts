import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { text } from 'node:stream/consumers';
import { gateway } from './gateway.ts';
import { choosePorts, listen } from './instance.ts';

test('the editor opens while the first upload waits, with its request body intact', async () => {
  const ports = await choosePorts(['public', 'api', 'room']);
  const requests: string[] = [];
  const api = createServer(async (req, res) => {
    requests.push(req.url!);
    res.end(await text(req) || 'OK');
  });
  await listen(api, ports.api);
  const front = gateway(ports, '.');
  await listen(front.server, ports.public);
  front.setReady();
  const url = 'http://127.0.0.1:' + ports.public;
  try {
    const body = Buffer.alloc(512 * 1024, 'a');
    const upload = fetch(url + '/api/workspaces/local/images', { method: 'POST', body });
    const index = await fetch(url + '/api/workspaces/local/index');
    assert.equal(await index.text(), 'OK');
    assert.equal(await (await fetch(url + '/api/workspaces/local/emojis')).text(), 'OK');
    assert.ok(!requests.includes('/api/workspaces/local/images'));
    front.setStorage('ready');
    assert.equal(await (await upload).text(), body.toString());
    assert.ok(requests.includes('/api/workspaces/local/images'));
    front.setStorage('failed');
    assert.equal((await fetch(url + '/files/file.png')).status, 503);
    assert.equal((await fetch(url + '/api/session')).status, 200);
  } finally {
    front.stopAccepting();
    await Promise.all([front.server, api].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

test('closing drains an admitted upload even when storage is still starting', async () => {
  const ports = await choosePorts(['public', 'api', 'room']);
  const api = createServer(async (req, res) => res.end(await text(req)));
  await listen(api, ports.api);
  const front = gateway(ports, '.');
  await listen(front.server, ports.public);
  front.setReady();
  try {
    const accepted = new Promise<void>(resolve => front.server.once('request', () => resolve()));
    const origin = 'http://127.0.0.1:' + ports.public;
    const upload = fetch(origin + '/api/workspaces/local/images', { method: 'POST', body: 'last image' });
    await accepted;
    const drained = front.stopAccepting();
    front.setStorage('ready');
    assert.equal(await (await upload).text(), 'last image');
    await drained;
    await assert.rejects(fetch(origin + '/api/session'));
  } finally {
    await front.stopAccepting();
    await Promise.all([front.server, api].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

test('existing device page URLs offer a manual native handoff and keep browser sign-in available', async () => {
  const ports = await choosePorts(['public', 'api', 'room']);
  const web = await mkdtemp(join(tmpdir(), 'blok-gateway-'));
  const front = gateway(ports, web);
  const origin = 'http://127.0.0.1:' + ports.public;
  try {
    await writeFile(join(web, 'index.html'), 'web shell');
    await listen(front.server, ports.public);
    front.setReady();
    const page = '2a8b1ae7-1bb0-4849-a6f9-87faf9211097';
    const response = await fetch(origin + '/?page=' + page);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes('href="blok://page/' + page + '?origin=' + encodeURIComponent(origin) + '"'));
    assert.ok(html.includes('href="/?page=' + page + '&amp;web=1"'));
    assert.doesNotMatch(html, /<script|http-equiv|\/internal\//i);
    assert.equal(response.headers.get('set-cookie'), null);
    const scoped = '/?page=' + page + '&workspace=work-1';
    const handoff = await (await fetch(origin + scoped)).text();
    assert.ok(handoff.includes('href="blok://page/' + page + '?origin=' + encodeURIComponent(origin) + '&amp;workspace=work-1"'));
    assert.ok(handoff.includes('href="/?page=' + page + '&amp;workspace=work-1&amp;web=1"'));
    const board = scoped + '&view=whiteboard';
    const boardHandoff = await (await fetch(origin + board)).text();
    assert.ok(boardHandoff.includes('href="blok://page/' + page + '?origin=' + encodeURIComponent(origin) + '&amp;workspace=work-1&amp;view=whiteboard"'));
    assert.ok(boardHandoff.includes('href="/?page=' + page + '&amp;workspace=work-1&amp;view=whiteboard&amp;web=1"'));
    for (const route of ['/', board + '&web=1', board + '&view=whiteboard', scoped + '&view=other', scoped + '&web=1', scoped + '&workspace=other', '/?page=a&workspace=%3C', '/?page=' + page + '&web=1', '/?view=calendar', '/?page=%3Cscript%3E', '/?page=a&page=b']) {
      assert.equal(await (await fetch(origin + route)).text(), 'web shell');
    }
    assert.equal((await fetch(origin + '/internal/desktop/session')).status, 404);
  } finally {
    await front.stopAccepting();
    await new Promise<void>(resolve => front.server.close(() => resolve()));
    await rm(web, {recursive: true, force: true});
  }
});
