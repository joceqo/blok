import { cp, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { appendJournal, type AppendRequest } from './append.ts';
import { replayJournal } from './replay.ts';

const fixture = fileURLToPath(new URL('../../../test/fixtures/go-journal-rich', import.meta.url));
function update(text: string) {
  const doc = new Doc();
  try { doc.getText('node').insert(0, text); return encodeStateAsUpdate(doc); }
  finally { doc.destroy(); }
}
describe.skipIf(!['linux', 'darwin'].includes(process.platform))('offline append on a canonical Go fixture', () => {
  let dir: string;
  let input: AppendRequest;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blok-append-'));
    await cp(fixture, dir, { recursive: true });
    input = { expectedLineage:'00112233445566778899aabbccddeeff', expectedThrough:3n,
      operationId:'ffffffffffffffffffffffffffffffff', actorId:'node', source:0, update:update('committed') };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive:true, force:true });
  });

  it('replays the committed bytes, recognizes retry before stale head and rejects reuse with a different digest', async () => {
    expect(await appendJournal(dir, input)).toEqual({outcome:'committed', sequence:4n});
    expect(await appendJournal(dir, input)).toEqual({outcome:'duplicate', sequence:4n});
    expect(await appendJournal(dir, {...input, update:update('other')})).toEqual({outcome:'conflict', sequence:4n});
    expect(await appendJournal(dir, {...input, expectedLineage:'0'.repeat(32)})).toEqual({outcome:'stale', sequence:4n});
    expect(await appendJournal(dir, {...input, operationId:'0'.repeat(32)})).toEqual({outcome:'stale', sequence:4n});
    const restored = new Doc();
    try { applyUpdate(restored, await replayJournal(dir)); expect(restored.getText('node').toString()).toBe('committed'); }
    finally { restored.destroy(); }
  });
  it('rejects malformed updates and missing Yjs dependencies without touching the journal', async () => {
    const journal = join(dir, 'journal.1.1');
    const original = await readFile(journal);
    await expect(appendJournal(dir, {...input, update:new Uint8Array([255])})).rejects.toThrow();
    const dependent = new Doc();
    try {
      dependent.getText('test').insert(0,'before');
      const vector = encodeStateVector(dependent);
      dependent.getText('test').insert(6,'after');
      await expect(appendJournal(dir,{...input,update:encodeStateAsUpdate(dependent,vector)})).rejects.toThrow('dependencies');
    } finally { dependent.destroy(); }
    expect(await readFile(journal)).toEqual(original);
  });
  it('rolls back a flush failure and only acknowledges the successful retry', async () => {
    const path = join(dir,'journal.1.1');
    const bytes = await readFile(path);
    const file = await open(path);
    const prototype = Object.getPrototypeOf(file) as typeof file;
    await file.close();
    vi.spyOn(prototype,'sync').mockRejectedValueOnce(new Error('injected fsync failure'));
    await expect(appendJournal(dir,input)).rejects.toThrow('injected fsync failure');
    expect(await readFile(path)).toEqual(bytes);
    expect(await appendJournal(dir,input)).toEqual({outcome:'committed',sequence:4n});
  });
});
