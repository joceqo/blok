import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyUpdate, Doc } from 'yjs';
import { it, expect } from 'vitest';
import { databaseChangeDetails } from './database-changes.ts';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';
import { restorePage, seedUpdate } from './page-document.ts';
import { appendJournal } from '../journal/append.ts';
import { startJournalRoom } from './preview.ts';

interface Case {
  name: string;
  type: string | null;
  before: { data?: unknown } | null;
  after: { data?: unknown } | null;
  fields: Record<string, unknown>;
}
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../../test/unit/server-conformance/fixtures/collab-history/property-changes.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cases: Case[] };

it.each(fixtures.cases)('matches the database history contract: $name', (c) => {
  expect(databaseChangeDetails(c.type, c.before, c.after)).toStrictEqual(c.fields);
});

it('serves the same database details on both history routes, through a reader ticket and after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-cell-history-'));
  const page = 'field-diff',
    directory = pageDirectory(root, page);
  function snapshot(status: string, name: string) {
    return {
      blocks: [
        {
          id: 'db',
          type: 'database',
          data: { schema: [{ id: 'st', name, type: 'select' }], views: [{ id: 'v', name }] },
        },
        { id: 'row', type: 'database-row', parent: 'db', data: { properties: { st: status } } },
      ],
    };
  }
  const seed = seedUpdate(snapshot('todo', 'Statut'));
  const baseline = newBaseline(seed),
    lineage = Buffer.from(baseline.lineage).toString('hex');
  const doc = new Doc();
  const start = () =>
    startJournalRoom({
      directory,
      documentId: page,
      allowedOrigins: new Set(['http://localhost']),
      authorize: async (ticket) => (ticket === 'reader' ? { id: 'reader', write: false } : null),
    });
  let host: Awaited<ReturnType<typeof start>> | undefined;
  try {
    applyUpdate(doc, seed);
    await initializePage(root, page, baseline, '{}', async () => {});
    await appendJournal(directory, {
      expectedLineage: lineage,
      expectedThrough: 0n,
      operationId: '1'.repeat(32),
      source: 0,
      update: restorePage(doc, snapshot('done', 'État')),
      actorId: 'member',
    });
    host = await start();
    const query = (path: string, token = 'reader') =>
      fetch(host!.url.replace('ws:', 'http:') + '/history/' + path, {
        headers: { Origin: 'http://localhost', Authorization: 'Bearer ' + token },
      });
    const version = lineage + '/1/changes';
    const blocks = [
      {
        id: 'db',
        schema: [{ id: 'st', name: 'État', action: 'updated' }],
        views: [{ id: 'v', action: 'updated' }],
      },
      { id: 'row', properties: [{ id: 'st', before: 'todo', after: 'done' }] },
    ];
    expect((await query(version + '?detail=properties', 'wrong')).status).toBe(403);
    for (const path of [version, 'changes']) {
      const res = await query(path + '?detail=properties');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ changes: [{ sequence: 1, blocks }] });
    }
    const invalidVersion = await (
      await query(version + '?detail=properties&DETAIL=properties&block=')
    ).json();
    expect(invalidVersion.changes[0].blocks).toHaveLength(2);
    expect(invalidVersion.changes[0].blocks[0]).not.toHaveProperty('schema');
    expect(invalidVersion.changes[0].blocks[1]).not.toHaveProperty('properties');
    expect((await query('changes?detail=unknown')).status).toBe(400);
    expect((await query('changes?block=row&block=db')).status).toBe(400);
    await host.close();
    host = await start();
    const narrowed = await (await query(version + '?block=row&DETAIL=properties')).json();
    expect(narrowed.changes[0].blocks).toHaveLength(1);
    expect(narrowed.changes[0].blocks[0]).toMatchObject(blocks[1]);
  } finally {
    doc.destroy();
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});
