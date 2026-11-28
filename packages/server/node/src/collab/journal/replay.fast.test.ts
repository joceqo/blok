import { cp, mkdtemp, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { afterEach, expect, it, vi } from 'vitest';

import * as journal from './inspect.ts';
import { replayJournal } from './replay.ts';

const fixture = fileURLToPath(new URL('../../../test/fixtures/go-journal/', import.meta.url));
afterEach(() => vi.restoreAllMocks());

it('rebuilds the final Go document from the checkpoint and its two later operations', async () => {
  const restored = new Doc();
  try {
    applyUpdate(restored, await replayJournal(fixture));
    expect(restored.getText('text').toString()).toBe('start-1-2-3');
    expect(restored.store.pendingStructs).toBeNull();
  } finally {
    restored.destroy();
  }
});

it('preserves rich text, deletions and the state vector from a format 2 baseline without a checkpoint', async () => {
  const rich = fileURLToPath(new URL('../../../test/fixtures/go-journal-rich/', import.meta.url));
  const restored = new Doc();
  try {
    applyUpdate(restored, await replayJournal(rich));
    expect(restored.getText('text').toString()).toBe('café 🍋 | moi + toi');
    expect(restored.getXmlFragment('body').toString()).toBe('<paragraph><bold>Important</bold><italic> à vérifier</italic></paragraph>');
    expect(Buffer.from(encodeStateVector(restored)).toString('hex')).toBe('0280200d80182a');
  } finally {
    restored.destroy();
  }
});

it('refuses an update with missing predecessors even when its journal record is intact', async () => {
  const source = new Doc();
  const report = await journal.inspectJournal(fixture);
  try {
    source.getText('x').insert(0, 'first');
    const vector = encodeStateVector(source);
    source.getText('x').insert(5, 'later');
    const suffix = encodeStateAsUpdate(source, vector);
    vi.spyOn(journal, 'inspectJournal').mockImplementationOnce(async (_, onUpdate) => {
      onUpdate?.({source: 'journal', sequence: 1n, update: suffix});
      return report;
    });
    await expect(replayJournal(fixture)).rejects.toThrow('unresolved Yjs dependencies');
  } finally {
    source.destroy();
  }
});

it('refuses to export a partial document when the last record is truncated', async () => {
  const copy = await mkdtemp(join(tmpdir(), 'journal-partial-'));
  try {
    await cp(fixture, copy, { recursive: true });
    const records = join(copy, 'journal.1.1');
    await truncate(records, (await stat(records)).size - 1);
    await expect(replayJournal(copy)).rejects.toThrow('integrity=incomplete');
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});
