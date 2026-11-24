import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Doc, applyUpdate } from 'yjs';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { inspectJournal } from '../journal/inspect.ts';
import { envelope, exportPage, matchesProjection, restorePage, seedUpdate } from './page-document.ts';
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

it('attaches an existing welcome page, publishes its canonical markup and reopens the same journal', async () => {
  const welcome = (bold: string) => ({
    title: 'Bienvenue sur Blok',
    blocks: [{
      id: 'welcome-legacy-slash', type: 'list', data: {
        text: `Cliquez n’importe où ci-dessous et <${bold}>tapez</${bold}> <code>/</code> pour voir ce que vous pouvez créer`,
        style: 'checklist', checked: false,
      },
    }],
  });
  const legacy = welcome('b');
  let remoteData = { version: '4', lineage: null as string | null, sequence: null as string | null, data: legacy };
  const put = vi.fn((request: RequestInit) => {
    const headers = new Headers(request.headers);
    expect(headers.get('Blok-Doc-Version')).toBe('4');
    remoteData = {
      version: '5', lineage: headers.get('Blok-Doc-Lineage'), sequence: headers.get('Blok-Doc-Sequence'),
      data: JSON.parse(String(request.body)),
    };
    return Response.json({ version: '5' });
  });
  vi.stubGlobal('fetch', vi.fn(async (_: URL, request: RequestInit) =>
    request.method === 'PUT' ? put(request) : Response.json(remoteData)));
  const open = () => preparePageStorage(root, 'page', 'http://localhost:8080', secret);
  const doc = new Doc();
  try {
    const storage = await open();
    const journal = await inspectJournal(storage.directory, frame => applyUpdate(doc, frame.update));
    expect(journal.integrity).toBe('ok');
    const lineage = journal.manifest!.lineage;
    await storage.attach(doc, lineage, 0n);
    expect(remoteData.data).toEqual(welcome('strong'));
    const reopened = await open();
    await reopened.attach(doc, lineage, 0n);
    expect(put).toHaveBeenCalledTimes(1);
    applyUpdate(doc, restorePage(doc, legacy));
    expect(reopened.validate(doc)).toEqual(remoteData.data);
  } finally {
    doc.destroy();
  }
});

it('keeps lossy markup, changed content and non-rich fields subject to exact round-trip checks', () => {
  const page = (type: string, text: string) => ({ blocks: [{ id: 'b', type, data: { text } }] });
  for (const text of ['<b class="color">a</b>', '<b>a<!--saved--></b>', '<b>a', '<b>a</b>\0']) {
    expect(() => seedUpdate(page('paragraph', text))).toThrow(/without loss/);
  }
  const original = page('paragraph', '<b>a</b>');
  expect(matchesProjection(page('paragraph', '<strong>b</strong>'), original)).toBe(false);
  expect(matchesProjection(page('paragraph', 'a'), original)).toBe(false);
  expect(matchesProjection(page('paragraph', '<strong>a</strong>'), { ...original, title: 'lost' })).toBe(false);
  expect(matchesProjection(page('custom', '<strong>a</strong>'), page('custom', '<b>a</b>'))).toBe(false);
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
