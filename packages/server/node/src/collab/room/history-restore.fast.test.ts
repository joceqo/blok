import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, Doc } from 'yjs';
import { expect, it } from 'vitest';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';
import { restorePage, seedUpdate } from './page-document.ts';
import { appendJournal } from '../journal/append.ts';
import { historyRequest } from './history.ts';

interface Preview {
  wouldUndo: { blocks: { id: string; type: string | null; kind: string }[]; page: string[] };
  guards: { kind: string; blockId: string }[];
}

/**
 * A document seeded with `baseline`, then carrying one record that writes
 * `after`. The preview of a restore back to sequence 0 is what each case reads.
 */
async function seeded(name: string, baseline: Record<string, unknown>, after: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'blok-restore-' + name + '-'));
  const directory = pageDirectory(root, name);
  const seed = seedUpdate(baseline);
  const start = newBaseline(seed);
  const lineage = Buffer.from(start.lineage).toString('hex');
  const doc = new Doc();
  applyUpdate(doc, seed);
  await initializePage(root, name, start, '{}', async () => {});
  const update = restorePage(doc, after);
  await appendJournal(directory, { expectedLineage: lineage, expectedThrough: 0n,
    operationId: '1'.repeat(32), source: 0, actorId: 'u1', update });
  applyUpdate(doc, update);

  return {
    doc,
    async preview(extra: { restoreTrashesPages?: boolean; actorId?: string | null } = {}) {
      const answer = await historyRequest({
        directory,
        doc,
        head: 1n,
        tag: { lineage, epoch: 0, format: 2 },
        request: {
          url: new URL('http://host/api/blok/sync/' + name + '/history/' + lineage + '/0/restore/preview'),
          method: 'POST',
          confirmed: [],
        },
        operations: new Map(),
        commit: async () => 0n,
        ...extra,
      });

      expect(answer.status).toBe(200);

      return answer.body as Preview;
    },
    /** A restore that commits through the caller's own writer, so it needs no lease. */
    restore(extra: { enforceRestoreGuards?: boolean; confirmed?: string[]; databases?: string } = {}) {
      const { confirmed = [], databases, ...rest } = extra;

      return historyRequest({
        directory,
        doc,
        head: 1n,
        tag: { lineage, epoch: 0, format: 2 },
        request: {
          url: new URL('http://host/api/blok/sync/' + name + '/history/' + lineage + '/0/restore'
            + (databases === undefined ? '' : '?databases=' + databases)),
          method: 'POST',
          key: 'k' + confirmed.join('-'),
          confirmed,
        },
        operations: new Map(),
        commit: async () => 7n,
        ...rest,
      });
    },
    async done() {
      doc.destroy();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('trashes a later page pointer in place only when the host asks for it', async () => {
  const paragraph = { id: 'a', type: 'paragraph', data: { text: 'one' } };
  const page = { id: 'pg', type: 'page', data: { title: 'Sub' } };
  const document = await seeded('trash', { blocks: [paragraph] }, { blocks: [paragraph, page] });

  try {
    const removed = await document.preview();

    expect(removed.wouldUndo.blocks).toEqual([{ id: 'pg', type: 'page', kind: 'removed' }]);

    const trashed = await document.preview({ restoreTrashesPages: true, actorId: 'u1' });

    // The pointer stays, stamped, so the sub-page keeps the document that points at it.
    expect(trashed.wouldUndo.blocks).toEqual([{ id: 'pg', type: 'page', kind: 'changed' }]);
  } finally {
    await document.done();
  }
});

it('names a locked database the target no longer holds as lockedReshape, not unlock', async () => {
  const database = {
    id: 'db',
    type: 'database',
    data: { schema: [{ id: 't', type: 'title', databaseLocked: true }], views: [{ id: 'v1', type: 'table' }] },
  };
  const document = await seeded('locked', { blocks: [] }, { blocks: [database] });

  try {
    const answer = await document.preview();

    expect(answer.guards).toEqual([{ kind: 'lockedReshape', blockId: 'db' }]);
  } finally {
    await document.done();
  }
});

it('asks before it restores only when the host enforces guards', async () => {
  const database = {
    id: 'db',
    type: 'database',
    data: { schema: [{ id: 't', type: 'title', databaseLocked: true }], views: [{ id: 'v1', type: 'table' }] },
  };
  const document = await seeded('enforce', { blocks: [] }, { blocks: [database] });

  try {
    const unasked = await document.restore({ enforceRestoreGuards: false });

    expect([unasked.status, unasked.headers?.['Blok-Doc-Sequence']]).toEqual([204, '7']);

    // A caller that names no policy gets the careful one.
    expect((await document.restore()).status).toBe(409);

    const asked = await document.restore({ enforceRestoreGuards: true });

    expect([asked.status, asked.headers?.['X-Blok-Restore-Refusal']]).toEqual([409, 'guards']);
    // The refusal names every guard the restore trips, not only the unconfirmed ones.
    expect((asked.body as { guards: { kind: string }[] }).guards).toEqual([{ kind: 'lockedReshape', blockId: 'db' }]);

    const confirmed = await document.restore({ enforceRestoreGuards: true, confirmed: ['lockedReshape'] });

    expect(confirmed.status).toBe(204);
  } finally {
    await document.done();
  }
});

it('refuses an orphaned database whether or not the host enforces guards', async () => {
  const box = { id: 'box', type: 'paragraph', data: { text: 'holder' } };
  const database = { id: 'db', type: 'database', parent: 'box', data: { schema: [], views: [] } };
  // The target holds neither the database nor the block it hangs from, so keeping
  // it would leave it pointing at a parent the restore does not write.
  const document = await seeded('orphan', { blocks: [] }, { blocks: [box, database] });

  try {
    for (const enforceRestoreGuards of [false, true]) {
      const answer = await document.restore({ enforceRestoreGuards, databases: 'keep' });

      expect([enforceRestoreGuards, answer.status]).toEqual([enforceRestoreGuards, 409]);
      expect((answer.body as { guards: { kind: string }[] }).guards)
        .toEqual([{ kind: 'orphanedDatabase', blockId: 'db' }]);
    }
  } finally {
    await document.done();
  }
});
