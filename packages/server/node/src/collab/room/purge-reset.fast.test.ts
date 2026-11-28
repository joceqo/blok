import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { startAllRooms, startJournalRoom } from './preview.ts';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';
import { seedUpdate } from './page-document.ts';
import { acquireJournalWriter } from '../journal/append.ts';
import { purgeDocument } from './purge.ts';
import { inspectJournal } from '../journal/inspect.ts';

const origin = 'http://localhost',
  secret = 'x'.repeat(32),
  page = 'my-page';
const auth = async (token: string, id: string) =>
  id === page && ['reader', 'writer'].includes(token)
    ? { id: token, write: token === 'writer', workspaceId: 'team' }
    : null;
const headers = (token: string) => ({ Origin: origin, Authorization: 'Bearer ' + token });
const doc = (text: string) => ({ blocks: [{ id: 'a', type: 'paragraph', data: { text: [{ text }] } }] });
const read = (base: string, action: string, method = 'GET', token = 'reader') =>
  fetch(base + '/' + action, { method, headers: headers(token) });

it('gates purge behind the host, fences competing writers and preserves only its persistent tombstone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-purge-'));
  const dir = pageDirectory(root, page),
    other = pageDirectory(root, 'unrelated');
  const run = () =>
    startJournalRoom({
      directory: dir,
      documentId: page,
      allowedOrigins: new Set([origin]),
      authorize: auth,
      recheckSecret: secret,
    });
  await initializePage(root, page, newBaseline(seedUpdate(doc('erase me'))), '{}', async () => {});
  await initializePage(root, 'unrelated', newBaseline(seedUpdate(doc('keep me'))), '{}', async () => {});
  let host = await run();
  try {
    const url = host.url.replace('ws:', 'http:');
    const control = new URL('/internal/room/purge?documentId=' + page, url);
    expect((await fetch(control, { method: 'POST', headers: headers('writer') })).status).toBe(401);
    await expect(host.purgeDocument(page, () => false)).rejects.toThrow('not authorized');
    const ws = new WebSocket(host.url, ['blok-sync.v2', 'writer'], { origin });
    await once(ws, 'open');
    const closed = once(ws, 'close');
    const otherProcesses = await acquireJournalWriter(other);
    try {
      await expect(purgeDocument(other, false)).rejects.toMatchObject({ code: 'JOURNAL_BUSY' });
    } finally {
      await otherProcesses.close();
    }
    const invoke = () => fetch(control, { method: 'POST', headers: headers(secret) });
    const attempts = await Promise.all([invoke(), invoke()]);
    expect(attempts.map((r) => r.status)).toEqual([204, 204]);
    expect((await closed)[0]).toBe(4403);
    expect((await readdir(dir)).sort()).toEqual(['lock', 'purged']);
    expect((await inspectJournal(other)).state).toBe('seeded');
    await host.close();
    host = await run();
    const base = host.url.replace('ws:', 'http:');
    for (const action of ['state', 'history']) expect((await read(base, action)).status).toBe(403);
    expect((await read(base, 'reset', 'POST', 'writer')).status).toBe(403);
    const upgraded = new WebSocket(host.url, ['blok-sync.v2', 'writer'], { origin });
    expect(
      await new Promise<number>((resolve, reject) => {
        upgraded.on('error', () => {});
        upgraded.once('unexpected-response', (_req, res) => {
          res.resume();
          resolve(res.statusCode!);
          upgraded.terminate();
        });
        upgraded.once('open', () => reject(new Error('Purged document opened')));
      }),
    ).toBe(403);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('authorizes reset, reloads changed canonical content, retains the previous lineage and recovers a lost projection receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-reset-'));
  let remote = {
    data: doc('original'),
    lineage: null as null | string,
    sequence: null as string | null,
    version: '0',
  };
  let drop = true;
  const backend = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.end(JSON.stringify(remote));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const data = JSON.parse(Buffer.concat(chunks).toString());
    const h = req.headers;
    if (
      h['blok-doc-version'] !== remote.version ||
      (h['blok-doc-expected-lineage'] || null) !== remote.lineage ||
      (h['blok-doc-expected-sequence'] || null) !== remote.sequence
    ) {
      res.writeHead(409).end();
      return;
    }
    if (h['blok-doc-reset'] === '1' && JSON.stringify(data) !== JSON.stringify(remote.data)) {
      res.writeHead(409).end();
      return;
    }
    remote = {
      data,
      lineage: String(h['blok-doc-lineage']),
      sequence: String(h['blok-doc-sequence']),
      version: String(Number(remote.version) + 1),
    };
    if (h['blok-doc-reset'] === '1' && drop) {
      drop = false;
      res.destroy();
      return;
    }
    res.end(JSON.stringify({ version: remote.version }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  if (!address || typeof address === 'string') throw Error('TCP address required');
  const run = () =>
    startAllRooms({
      directory: root,
      projection: { origin: 'http://127.0.0.1:' + address.port, secret },
      authorize: auth,
      allowedOrigins: new Set([origin]),
      recheckSecret: secret,
    });
  let host = await run();
  try {
    let base = host.url.replace('ws:', 'http:') + page;
    expect((await read(base, 'state')).status).toBe(200);
    const previous = remote.lineage;
    expect((await read(base, 'reset', 'POST')).status).toBe(403);
    expect(remote.lineage).toBe(previous);
    const ws = new WebSocket(host.url + page, ['blok-sync.v2', 'writer'], { origin });
    await once(ws, 'open');
    const closed = once(ws, 'close');
    remote = { ...remote, data: doc('canonical'), version: String(Number(remote.version) + 1) };
    expect((await read(base, 'reset', 'POST', 'writer')).status).toBe(503);
    expect((await closed)[0]).toBe(4409);
    expect(remote.lineage).not.toBe(previous);
    expect(remote.sequence).toBe('0');
    await host.close();
    host = await run();
    base = host.url.replace('ws:', 'http:') + page;
    const state = await read(base, 'state');
    expect(await state.json()).toEqual(doc('canonical'));
    expect(state.headers.get('Blok-Doc-Lineage')).toBe(remote.lineage);
    expect(await (await read(base, 'history/' + previous + '/0')).json()).toMatchObject(doc('original'));
    expect((await read(base, 'reset', 'POST', 'writer')).status).toBe(204);
    const dir = pageDirectory(root, page);
    expect((await inspectJournal(dir)).manifest?.epoch).toBe(2n);
    const key = dir.slice(0, -'.journal'.length);
    await writeFile(key + '.unreadable-old', 'old sensitive data');
    await writeFile(key, 'working copy');
    const staged = join(root, '.seed-' + key.split('/').at(-1) + '-aaaaaa');
    await mkdir(staged);
    await writeFile(join(staged, 'baseline'), 'unpublished document');
    const historicStage = join(root, '.seed-old001');
    await mkdir(historicStage);
    await writeFile(join(historicStage, 'node-projection.json'), JSON.stringify({ pageId: page }));
    const neighbor = join(root, '.seed-old002');
    await mkdir(neighbor);
    await writeFile(join(neighbor, 'node-projection.json'), JSON.stringify({ pageId: 'some-other-page' }));
    const foreign = await acquireJournalWriter(dir);
    const control = new URL('/internal/room/purge?documentId=' + page, base);
    try {
      expect((await fetch(control, { method: 'POST', headers: headers(secret) })).status).toBe(409);
    } finally {
      await foreign.close();
    }
    // The refused purge erased nothing and wrote no tombstone: the record is still served.
    expect((await read(base, 'state')).status).toBe(200);
    await writeFile(join(root, '.blok-collab-0123456789abcdef0123456789abcdef'), 'unknown document');
    expect((await fetch(control, { method: 'POST', headers: headers(secret) })).status).toBe(503);
    expect((await read(base, 'state')).status).toBe(403);
    await rm(join(root, '.blok-collab-0123456789abcdef0123456789abcdef'));
    expect((await fetch(control, { method: 'POST', headers: headers(secret) })).status).toBe(204);
    await expect(readFile(key + '.unreadable-old')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(key)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(historicStage)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(neighbor)).toEqual(['node-projection.json']);
  } finally {
    await host.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

it('readmits a document after a purge that failed before writing any tombstone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-purge-retry-'));
  const snapshot = { data: null as unknown, version: '0', lineage: null as string | null, sequence: null as string | null };
  const backend = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify(snapshot));
      return;
    }
    req.resume();
    snapshot.version = String(Number(snapshot.version) + 1);
    snapshot.lineage = String(req.headers['blok-doc-lineage']);
    snapshot.sequence = String(req.headers['blok-doc-sequence']);
    res.end(JSON.stringify({ version: snapshot.version }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  if (!address || typeof address === 'string') throw Error('TCP address required');
  const host = await startAllRooms({
    directory: root,
    projection: { origin: 'http://127.0.0.1:' + address.port, secret },
    authorize: auth,
    allowedOrigins: new Set([origin]),
    recheckSecret: secret,
  });
  try {
    const base = host.url.replace('ws:', 'http:') + page;
    expect((await read(base, 'state')).status).toBe(200);
    // Take the lease the idle room has just dropped, so the purge is refused by a competing writer.
    const dir = pageDirectory(root, page);
    let foreign: Awaited<ReturnType<typeof acquireJournalWriter>> | undefined;
    for (let attempt = 0; attempt < 200 && !foreign; attempt += 1) {
      try {
        foreign = await acquireJournalWriter(dir);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!foreign) throw new Error('The idle room never released its lease');
    try {
      await expect(host.purgeDocument(page, () => true)).rejects.toMatchObject({ code: 'JOURNAL_BUSY' });
    } finally {
      await foreign.close();
    }
    // Nothing was erased and no tombstone exists: the document must not stay unreachable.
    expect((await read(base, 'state')).status).toBe(200);
  } finally {
    await host.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
