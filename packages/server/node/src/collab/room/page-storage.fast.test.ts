import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Doc, applyUpdate } from 'yjs';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { envelope, exportPage, seedUpdate } from './page-document.ts';
import { pageDirectory } from './page-seed.ts';
import { preparePageStorage } from './page-storage.ts';

const secret = 'x'.repeat(40);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blok-page-seed-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function remote(response: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(response)),
  );
  return preparePageStorage(root, 'page', 'http://localhost:8080', secret);
}

it('round-trips editor metadata, paragraph text and snapshot envelope fields', () => {
  const snapshot = {
    title: 'Document',
    time: 777,
    blocks: [{ id: 'b', type: 'paragraph', data: { text: 'actual text' } }],
  };
  const doc = new Doc();
  try {
    applyUpdate(doc, seedUpdate(snapshot));
    expect(exportPage(doc, envelope(snapshot))).toEqual(snapshot);
    doc.getMap('unknown').set('key', 'value');
    expect(() => exportPage(doc, {})).toThrow(/Unprojectable Yjs root/);
  } finally {
    doc.destroy();
  }
});

it('refuses lossy JSON and a missing journal for a known lineage', async () => {
  await expect(
    remote('{"version":"4","lineage":null,"sequence":null,"data":{"blocks":[],"n":9007199254740993}}'),
  ).rejects.toThrow(/Unrepresentable JSON number/);
  await expect(
    remote(JSON.stringify({ version: '4', lineage: 'a'.repeat(32), sequence: '9', data: { blocks: [] } })),
  ).rejects.toThrow(/matching journal/);
  expect(() => seedUpdate({ blocks: [{ type: 'paragraph', data: { text: 'missing ID' } }] })).toThrow();
});

it('keeps an unreadable legacy Go working set untouched', async () => {
  const workingSet = pageDirectory(root, 'page').slice(0, -'.journal'.length);
  await writeFile(workingSet, 'old Go working set');
  await expect(remote('{"version":"0","lineage":null,"sequence":null,"data":null}')).rejects.toThrow(
    /Go working-set header/,
  );
  expect(await readFile(workingSet, 'utf8')).toBe('old Go working set');
});
