import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
