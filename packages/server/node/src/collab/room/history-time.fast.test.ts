import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, Doc } from 'yjs';
import { expect, it } from 'vitest';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';
import { restorePage, seedUpdate } from './page-document.ts';
import { appendJournal } from '../journal/append.ts';
import { writeRecordNote } from './record-notes.ts';
import { historyRequest } from './history.ts';

it('shapes a range row the way the collab HTTP contract reads it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-history-range-'));
  const page = 'range-1',
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
  const ask = (notes?: boolean) =>
    historyRequest({
      directory,
      doc,
      head: 2n,
      tag: { lineage, epoch: 1, format: 2 },
      request: {
        url: new URL('http://host/api/blok/sync/' + page + '/history/changes?from=2000-01-01T00:00:00Z'),
        method: 'GET',
        confirmed: [],
      },
      operations: new Map(),
      commit: async () => 0n,
      ...(notes === undefined ? {} : { recordNotes: notes }),
    });
  type Row = { lineage: string; sequence: number; actor: string | null; actors?: unknown[]; page?: string[] };
  try {
    // `page` only when a page field moved; `actors` only with record notes on.
    const bare = await ask(false);
    const rows = (bare.body as { changes: Row[] }).changes;

    expect(rows.map((row) => Object.keys(row))).toEqual([
      ['lineage', 'sequence', 'committedAt', 'actor', 'blocks', 'page'],
      ['lineage', 'sequence', 'committedAt', 'actor', 'blocks'],
    ]);
    // Newest first, each naming the lineage it belongs to.
    expect(rows.map((row) => [row.lineage, row.sequence, row.actor])).toEqual([
      [lineage, 2, 'u1'],
      [lineage, 1, null],
    ]);
    expect(rows[0]?.page).toEqual(['title']);

    const noted = await ask(true);

    expect((noted.body as { changes: Row[] }).changes.map((row) => Object.keys(row))).toEqual([
      ['lineage', 'sequence', 'committedAt', 'actor', 'actors', 'blocks', 'page'],
      ['lineage', 'sequence', 'committedAt', 'actor', 'actors', 'blocks'],
    ]);
    expect((noted.body as { changes: Row[] }).changes[0]?.actors).toEqual([{ id: 'u1', kind: 'person' }]);
  } finally {
    doc.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
