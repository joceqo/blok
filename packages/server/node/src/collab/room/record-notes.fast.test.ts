import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startJournalRoom } from './preview.ts';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';
import { seedUpdate } from './page-document.ts';
import { notesFilename, readRecordNotes, recordActor, writeRecordNote } from './record-notes.ts';

it('matches notes to a lineage and operation, and isolates an interrupted append', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blok-notes-'));
  const lineage = 'a'.repeat(32),
    op1 = '1'.repeat(32),
    op2 = '2'.repeat(32);
  try {
    await writeRecordNote(directory, lineage, 1n, op1, { kind: 'person' });
    await appendFile(join(directory, notesFilename(lineage)), '{"sequence":"2","operationId"');
    await writeRecordNote(directory, lineage, 2n, op2, { kind: 'agent', onBehalfOf: 'owner' });
    const notes = await readRecordNotes(directory, lineage);
    expect(recordActor(notes, { sequence: 1n, operationId: op1 }, 'agent:pretender')).toEqual({
      id: 'agent:pretender',
      kind: 'person',
    });
    expect(recordActor(notes, { sequence: 2n, operationId: op2 }, 'agent:real')).toEqual({
      id: 'agent:real',
      kind: 'agent',
      onBehalfOf: 'owner',
    });
    expect(recordActor(notes, { sequence: 2n, operationId: op1 }, 'someone')).toBeUndefined();
    expect(recordActor(notes, { sequence: 2n, operationId: op2 }, null)).toBeUndefined();
    expect(await readRecordNotes(directory, 'b'.repeat(32))).toEqual(new Map());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps a durable restore and its replay intact when the note store is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blok-missing-notes-'));
  const documentId = 'notes',
    directory = pageDirectory(root, documentId);
  const baseline = newBaseline(seedUpdate({ blocks: [] }));
  const lineage = Buffer.from(baseline.lineage).toString('hex');
  await initializePage(root, documentId, baseline, '{}', async () => {});
  // A directory at the file path makes reads and writes fail on every operating system.
  await mkdir(join(directory, notesFilename(lineage)));
  const host = await startJournalRoom({
    directory,
    documentId,
    allowedOrigins: new Set(['http://localhost']),
    authorize: async () => ({ id: 'human', write: true }),
  });
  const base = host.url.replace('ws:', 'http:') + '/history';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const headers = { Authorization: 'Bearer token', 'Blok-Idempotency-Key': 'restore-1' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await fetch(base + '/' + lineage + '/0/restore', { method: 'POST', headers });
      expect(result.status).toBe(204);
      expect(result.headers.get('Blok-Doc-Sequence')).toBe('1');
    }
    const response = await fetch(base, { headers });
    expect((await response.json()).versions[0]).toMatchObject({
      sequence: 1,
      actors: ['human'],
      actorKinds: [],
    });
    expect(warn).toHaveBeenCalledWith('Could not persist collaboration record note');
  } finally {
    warn.mockRestore();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
