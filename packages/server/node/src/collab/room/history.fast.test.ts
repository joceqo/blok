import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, Doc } from 'yjs';
import { expect, it } from 'vitest';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';
import { restorePage, seedUpdate } from './page-document.ts';
import { acquireJournalWriter, appendJournal } from '../journal/append.ts';
import { notesFilename, writeRecordNote } from './record-notes.ts';
import { startJournalRoom } from './preview.ts';
import { historyRead, historyRequest } from './history.ts';

it('serves guarded version reads and recoverable restores from the actual journal over HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-history-'));
  const page = 'demo-1',
    dir = pageDirectory(root, page);
  const snapshot = (text: string) => ({ blocks: [{ id: 'a', type: 'paragraph', data: { text } }] });
  // A legacy source still spells its rich field in HTML; the projection answers segments.
  const projected = (text: string) => ({ blocks: [{ id: 'a', type: 'paragraph', data: { text: [{ text }] } }] });
  const seed = seedUpdate(snapshot('old'));
  const baseline = newBaseline(seed);
  const lineage = Buffer.from(baseline.lineage).toString('hex');
  const doc = new Doc();
  applyUpdate(doc, seed);
  await initializePage(root, page, baseline, '{}', async () => {});
  await appendJournal(dir, {
    expectedLineage: lineage,
    expectedThrough: 0n,
    operationId: '1'.repeat(32),
    source: 0,
    actorId: 'account-1',
    update: restorePage(doc, snapshot('new')),
  });
  const origin = 'http://localhost';
  const run = () =>
    startJournalRoom({
      directory: dir,
      documentId: page,
      allowedOrigins: new Set([origin]),
      authorize: async (token) =>
        ['reader', 'editor'].includes(token) ? { id: token, write: token === 'editor' } : null,
    });
  let host = await run();
  const request = (suffix = '', token = 'reader', method = 'GET', headers: Record<string, string> = {}) =>
    fetch(host.url.replace('ws:', 'http:') + '/history' + suffix, {
      method,
      headers: { Authorization: 'Bearer ' + token, Origin: origin, ...headers },
    });
  const restore = '/' + lineage + '/0/restore';
  const key = { 'Blok-Idempotency-Key': 'first-restore' };
  try {
    expect((await request('', 'unauthorized')).status).toBe(403);
    const list = await request();
    expect(await list.json()).toMatchObject({
      versions: [{ sequence: 1, actors: ['account-1'], actorKinds: [] }, { sequence: 0, actorKinds: [] }],
    });
    const old = await request('/' + lineage + '/0');
    expect(await old.json()).toMatchObject(projected('old'));
    expect((await request(restore, 'reader', 'POST', key)).status).toBe(403);
    const preview = await request(restore + '/preview', 'editor', 'POST');
    expect(await preview.json()).toMatchObject({
      expectRevision: lineage + ':1',
      fits: true,
      wouldUndo: { blocks: [{ kind: 'changed', id: 'a' }] },
    });
    expect(
      (await request(restore, 'editor', 'POST', { ...key, 'If-Match': '"' + lineage + ':0"' })).status,
    ).toBe(412);
    expect((await request(restore, 'editor', 'POST', key)).status).toBe(204);
    await host.close();
    host = await run();
    expect(
      (await request(restore, 'editor', 'POST', { ...key, 'If-Match': '"' + lineage + ':1"' })).status,
    ).toBe(204);
    expect((await request('/' + lineage + '/1/restore', 'editor', 'POST', key)).status).toBe(409);
    const head = await request('/' + lineage + '/2');
    expect(await head.json()).toMatchObject(projected('old'));
    const changes = await request('/' + lineage + '/2/changes?since=1');
    expect(await changes.json()).toMatchObject({
      changes: [{ sequence: 2, actors:[{id:'editor',kind:'person'}], blocks: [{ id: 'a', kind: 'changed' }] }],
      truncated: false,
    });
  } finally {
    doc.destroy();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('resolves an old Go ledger generation and tombstones only the requested archived version', async () => {
  const { copyFile, readFile, writeFile, stat } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'blok-archived-')),
    page = 'archive';
  const directory = pageDirectory(root, page);
  const before = newBaseline(
    seedUpdate({ blocks: [{ id: 'a', type: 'paragraph', data: { text: 'archive' } }] }),
  );
  const old = 'b'.repeat(32),
    live = Buffer.from(before.lineage).toString('hex');
  await initializePage(root, page, before, '{}', async () => {});
  for (const name of ['baseline', 'journal'])
    await copyFile(join(directory, name + '.1.1'), join(directory, name + '.2.1'));
  const manifest = await readFile(join(directory, 'manifest'));
  const slot = manifest.subarray(128);
  slot.writeBigUInt64LE(2n, 24);
  createHash('sha256').update(slot.subarray(0, 96)).digest().copy(slot, 96);
  await writeFile(join(directory, 'manifest'), manifest);
  const ledger = Buffer.alloc(61);
  ledger[0] = 1;
  ledger.writeBigUInt64LE(1n, 1);
  ledger.writeBigUInt64LE(1n, 9);
  Buffer.from(old, 'hex').copy(ledger, 17);
  ledger.writeBigInt64LE(1n, 33);
  ledger.writeInt32LE(2, 41);
  ledger.writeBigInt64LE(621355968000000000n, 45);
  createHash('sha256').update(ledger.subarray(0, 53)).digest().copy(ledger, 53, 0, 8);
  await writeFile(join(directory, 'lineages'), ledger);
  await writeRecordNote(directory,old,1n,'1'.repeat(32),{kind:'agent',onBehalfOf:'user'});
  const host = await startJournalRoom({
    directory,
    documentId: page,
    allowedOrigins: new Set(['http://localhost']),
    authorize: async (token) => (token === 'ok' ? { id: 'ok', write: true } : null),
  });
  const req = (path: string, method = 'GET') =>
    fetch(host.url.replace('ws:', 'http:') + '/history' + path, {
      method,
      headers: { Authorization: 'Bearer ok', Accept: 'application/json' },
    });
  try {
    expect(await (await req('')).json()).toMatchObject({
      lineages: [
        { lineage: live, current: true },
        { lineage: old, current: false },
      ],
    });
    expect(await (await req('/' + old + '/0')).json()).toMatchObject({
      blocks: [{ data: { text: [{ text: 'archive' }] } }],
    });
    expect(await (await req('/at?time=1970-01-01T00:00:00Z')).json()).toMatchObject({
      lineage: old,
      sequence: 0,
    });
    expect((await req('/' + live, 'DELETE')).status).toBe(409);
    expect((await req('/' + old, 'DELETE')).status).toBe(204);
    expect((await req('/' + old + '/0')).status).toBe(404);
    await expect(stat(join(directory,notesFilename(old)))).rejects.toMatchObject({code:'ENOENT'});
    await expect(stat(join(directory, 'baseline.1.1'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await req('/' + live + '/0')).status).toBe(200);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('shapes a changes row and a version point the way the collab HTTP contract reads them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-history-shape-'));
  const page = 'shape-1',
    directory = pageDirectory(root, page);
  const snapshot = (text: string, title?: string) => ({
    blocks: [{ id: 'a', type: 'paragraph', data: { text } }],
    ...(title === undefined ? {} : { title }),
  });
  const seed = seedUpdate(snapshot('one'));
  const baseline = newBaseline(seed);
  const lineage = Buffer.from(baseline.lineage).toString('hex');
  const doc = new Doc();
  applyUpdate(doc, seed);
  await initializePage(root, page, baseline, '{}', async () => {});
  // Record 1 carries no actor and touches no page field; record 2 is a noted
  // person renaming the page.
  const anonymous = restorePage(doc, snapshot('two'));
  await appendJournal(directory, { expectedLineage: lineage, expectedThrough: 0n,
    operationId: '1'.repeat(32), source: 0, actorId: '', update: anonymous });
  applyUpdate(doc, anonymous);
  await new Promise((done) => setTimeout(done, 2));
  const renamed = restorePage(doc, snapshot('two', 'Titled'));
  await appendJournal(directory, { expectedLineage: lineage, expectedThrough: 1n,
    operationId: '2'.repeat(32), source: 0, actorId: 'u1', update: renamed });
  applyUpdate(doc, renamed);
  await writeRecordNote(directory, lineage, 2n, '2'.repeat(32), { kind: 'person' });
  const ask = (suffix: string, notes?: boolean) =>
    historyRequest({
      directory,
      doc,
      head: 2n,
      tag: { lineage, epoch: 1, format: 2 },
      request: { url: new URL('http://host/api/blok/sync/' + page + '/history' + suffix), method: 'GET', confirmed: [] },
      operations: new Map(),
      commit: async () => 0n,
      ...(notes === undefined ? {} : { recordNotes: notes }),
    });
  type Row = { sequence: number; committedAt: number; actor: string | null; actors?: unknown[]; page?: string[] };
  try {
    const window = await ask('/' + lineage + '/2/changes?since=0');
    const rows = (window.body as { changes: Row[] }).changes;

    // `page` only when a page field moved; `actors` only with record notes on.
    expect(rows.map((row) => Object.keys(row))).toEqual([
      ['sequence', 'committedAt', 'actor', 'actors', 'blocks'],
      ['sequence', 'committedAt', 'actor', 'actors', 'blocks', 'page'],
    ]);
    // A record written without an actor reads as null, never as the empty string.
    expect(rows.map((row) => row.actor)).toEqual([null, 'u1']);
    expect([rows[1]?.page, rows[1]?.actors]).toEqual([['title'], [{ id: 'u1', kind: 'person' }]]);

    const bare = await ask('/' + lineage + '/2/changes?since=0', false);

    expect((bare.body as { changes: Row[] }).changes.map((row) => Object.keys(row))).toEqual([
      ['sequence', 'committedAt', 'actor', 'blocks'],
      ['sequence', 'committedAt', 'actor', 'blocks', 'page'],
    ]);

    // The list names createdAt before current, and keeps actorKinds for a
    // host that reads record notes.
    const bareList = await ask('', false);
    const listed = bareList.body as { lineages: object[]; versions: object[] };

    expect(Object.keys(listed.lineages[0] ?? {})).toEqual(['lineage', 'epoch', 'format', 'createdAt', 'current']);
    expect(listed.versions.map((version) => Object.keys(version))).toEqual([
      ['lineage', 'sequence', 'startedAt', 'savedAt', 'actors'],
      ['lineage', 'sequence', 'startedAt', 'savedAt', 'actors'],
    ]);

    const notedList = await ask('', true);

    expect(Object.keys((notedList.body as { versions: object[] }).versions[0] ?? {}))
      .toEqual(['lineage', 'sequence', 'startedAt', 'savedAt', 'actors', 'actorKinds']);

    // The point carries its own time, not the time of the newest record read.
    const point = await ask('/' + lineage + '/1');

    expect((point.body as { time: number }).time).toBe(rows[0]?.committedAt);
    expect((point.body as { time: number }).time).not.toBe(rows[1]?.committedAt);
  } finally {
    doc.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

it('reads the history of a document another writer holds, and refuses what needs the live document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-history-detached-'));
  const page = 'held-1',
    directory = pageDirectory(root, page);
  const snapshot = (text: string) => ({ blocks: [{ id: 'a', type: 'paragraph', data: { text } }] });
  const seed = seedUpdate(snapshot('one'));
  const baseline = newBaseline(seed);
  const lineage = Buffer.from(baseline.lineage).toString('hex');
  const doc = new Doc();
  applyUpdate(doc, seed);
  await initializePage(root, page, baseline, '{}', async () => {});
  const second = restorePage(doc, snapshot('two'));
  await appendJournal(directory, { expectedLineage: lineage, expectedThrough: 0n,
    operationId: '1'.repeat(32), source: 0, actorId: 'u1', update: second });
  applyUpdate(doc, second);
  const ask = (suffix: string) =>
    historyRead({
      directory,
      request: { url: new URL('http://host/api/blok/sync/' + page + '/history' + suffix), method: 'GET', confirmed: [] },
      recordNotes: false,
    });
  // Another server owns the document: its lease is what this read must not need.
  const holder = await acquireJournalWriter(directory);
  try {
    await expect(acquireJournalWriter(directory)).rejects.toMatchObject({ code: 'JOURNAL_BUSY' });

    const list = await ask('');

    expect(list.status).toBe(200);
    expect((list.body as { versions: { sequence: number }[] }).versions.map((v) => v.sequence)).toEqual([1, 0]);

    const point = await ask('/' + lineage + '/1');

    expect([point.status, (point.body as { blocks: { id: string }[] }).blocks.map((b) => b.id)]).toEqual([200, ['a']]);

    const changes = await ask('/' + lineage + '/1/changes');

    expect([changes.status, (changes.body as { changes: { sequence: number }[] }).changes.map((c) => c.sequence)])
      .toEqual([200, [1]]);

    const ranged = await ask('/changes?from=2000-01-01T00:00:00Z');

    expect((ranged.body as { changes: { lineage: string; sequence: number }[] }).changes.map((c) => [c.lineage, c.sequence]))
      .toEqual([[lineage, 1]]);

    const at = await ask('/at?time=2999-01-01T00:00:00Z');

    expect([at.status, (at.headers ?? {})['Blok-History-Sequence']]).toEqual([302, '1']);

    // The state door and a restore both read the live document, which only the
    // holder of the lease has.
    expect((await ask('/../state')).status).toBe(405);
    expect((await historyRead({
      directory,
      request: { url: new URL('http://host/api/blok/sync/' + page + '/history/' + lineage + '/0/restore'),
        method: 'POST', key: 'k1', confirmed: [] },
    })).status).toBe(405);
  } finally {
    doc.destroy();
    await holder.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a stale head only when a room answers for the document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-history-stale-'));
  const page = 'stale-1',
    directory = pageDirectory(root, page);
  const seed = seedUpdate({ blocks: [{ id: 'a', type: 'paragraph', data: { text: 'one' } }] });
  const baseline = newBaseline(seed);
  const lineage = Buffer.from(baseline.lineage).toString('hex');
  const doc = new Doc();
  applyUpdate(doc, seed);
  await initializePage(root, page, baseline, '{}', async () => {});
  await appendJournal(directory, { expectedLineage: lineage, expectedThrough: 0n,
    operationId: '1'.repeat(32), source: 0, actorId: 'u1',
    update: restorePage(doc, { blocks: [{ id: 'a', type: 'paragraph', data: { text: 'two' } }] }) });
  // Sequence 0 is behind the journal, as a reader's head is the moment another
  // server appends to the same directory.
  const ask = (detached: boolean) =>
    historyRequest({
      directory,
      doc,
      head: 0n,
      tag: { lineage, epoch: 1, format: 2 },
      request: { url: new URL('http://host/api/blok/sync/' + page + '/history'), method: 'GET', confirmed: [] },
      operations: new Map(),
      commit: async () => 0n,
      detached,
    });
  try {
    const detached = await ask(true);

    expect([detached.status, (detached.body as { versions: { sequence: number }[] }).versions.map((v) => v.sequence)])
      .toEqual([200, [1, 0]]);
    // A room that holds the lease IS the authority, so a journal that moved
    // under it is a fault, not a race.
    await expect(ask(false)).rejects.toThrow('Inconsistent history');
  } finally {
    doc.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

it('orders a record\'s blocks as the after document holds them, then what it dropped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-history-order-'));
  const page = 'order-1',
    directory = pageDirectory(root, page);
  const paragraph = (id: string, text: string) => ({ id, type: 'paragraph', data: { text } });
  const seed = seedUpdate({ blocks: [paragraph('a', 'one'), paragraph('b', 'one'), paragraph('gone', 'one')] });
  const baseline = newBaseline(seed);
  const lineage = Buffer.from(baseline.lineage).toString('hex');
  const doc = new Doc();
  applyUpdate(doc, seed);
  await initializePage(root, page, baseline, '{}', async () => {});
  // `added` lands before `a`, `b` changes, `gone` leaves: the after document
  // interleaves an addition and a change that the old grouping kept apart.
  await appendJournal(directory, { expectedLineage: lineage, expectedThrough: 0n,
    operationId: '1'.repeat(32), source: 0, actorId: 'u1',
    update: restorePage(doc, { blocks: [paragraph('added', 'new'), paragraph('a', 'one'), paragraph('b', 'two')] }) });
  try {
    const answer = await historyRequest({
      directory,
      doc,
      head: 1n,
      tag: { lineage, epoch: 0, format: 2 },
      request: { url: new URL('http://host/api/blok/sync/' + page + '/history/' + lineage + '/1/changes'),
        method: 'GET', confirmed: [] },
      operations: new Map(),
      commit: async () => 0n,
      recordNotes: false,
    });
    const rows = (answer.body as { changes: { blocks: { id: string; kind: string }[] }[] }).changes;

    expect(rows[0]?.blocks.map(({ id, kind }) => [id, kind])).toEqual([
      ['added', 'added'],
      ['b', 'changed'],
      ['gone', 'removed'],
    ]);
  } finally {
    doc.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
