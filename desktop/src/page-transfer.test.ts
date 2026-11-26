import { afterEach, expect, it, vi } from 'vitest';
import { assetUrls, blockingDatabase, inlineAsset, isServerAsset, planTransfer, rewriteDocument, transferSubtree } from './page-transfer';
import { openWorkspaceTransfer } from './navigation-dialogs';

afterEach(() => { document.querySelector<HTMLButtonElement>('[data-navigation-close]')?.click(); document.body.replaceChildren(); vi.restoreAllMocks(); });

const pages = [
  { id: 'source', title: 'Source', parentId: null },
  { id: 'child', title: 'Child', parentId: 'source' },
  { id: 'grandchild', title: 'Grandchild', parentId: 'child' },
  { id: 'elsewhere', title: 'Ailleurs', parentId: null },
];

it('collects the subtree parents before children, and nothing else', () => {
  expect(transferSubtree(pages, 'source').map(page => page.id)).toEqual(['source', 'child', 'grandchild']);
  expect(transferSubtree(pages, 'child').map(page => page.id)).toEqual(['child', 'grandchild']);
  expect(transferSubtree(pages, 'absent')).toEqual([]);
});

it('ignores a parent cycle rather than looping forever', () => {
  const looped = [{ id: 'a', title: 'A', parentId: 'b' }, { id: 'b', title: 'B', parentId: 'a' }];
  expect(transferSubtree(looped, 'a').map(page => page.id)).toEqual(['a', 'b']);
});

it('names the database that blocks a transfer, and passes a plain document', () => {
  expect(blockingDatabase({ blocks: [{ id: 'b1', type: 'database', data: { title: 'Suivi' } }] })).toBe('Suivi');
  expect(blockingDatabase({ blocks: [{ id: 'b1', type: 'paragraph', data: { text: 'bonjour' } }] })).toBeNull();
  expect(blockingDatabase(null)).toBeNull();
});

it('rewrites page identifiers in links, in internal hrefs and nowhere else', () => {
  const document = {
    title: 'Page',
    blocks: [
      { id: 'b1', type: 'page-link', data: { pageId: 'child' } },
      { id: 'b2', type: 'page-link', data: { pageId: 'elsewhere' } },
      { id: 'b3', type: 'paragraph', data: { text: [{ text: 'voir', marks: [{ type: 'link', href: '/?page=child&local=1' }] }] } },
      { id: 'b4', type: 'paragraph', data: { text: [{ text: 'mcp', marks: [{ type: 'link', href: 'blok://page/child' }] }] } },
      { id: 'b5', type: 'paragraph', data: { text: [{ text: 'dehors', marks: [{ type: 'link', href: 'https://example.com/?page=child' }] }] } },
    ],
  };
  const rewritten = rewriteDocument(document, { ids: new Map([['child', 'fresh']]), urls: new Map() }) as typeof document;
  expect(rewritten.blocks[0]?.data).toEqual({ pageId: 'fresh' });
  expect(rewritten.blocks[1]?.data).toEqual({ pageId: 'elsewhere' });
  expect(JSON.stringify(rewritten.blocks[2])).toContain('page=fresh');
  expect(JSON.stringify(rewritten.blocks[3])).toContain('blok://page/fresh');
  expect(JSON.stringify(rewritten.blocks[4])).toContain('https://example.com/?page=child');
  expect(document.blocks[0]?.data).toEqual({ pageId: 'child' });
});

it('collects every asset url once, including image variants', () => {
  const document = {
    blocks: [
      { id: 'b1', type: 'image', data: { url: 'data:image/png;base64,AAA', variants: [{ url: 'data:image/png;base64,BBB' }] } },
      { id: 'b2', type: 'image', data: { url: 'data:image/png;base64,AAA' } },
      { id: 'b3', type: 'file', data: { url: 'https://server.test/files/a1.pdf' } },
      { id: 'b4', type: 'paragraph', data: { text: 'rien' } },
    ],
  };
  expect(assetUrls(document)).toEqual(['data:image/png;base64,AAA', 'data:image/png;base64,BBB', 'https://server.test/files/a1.pdf']);
});

it('replaces asset urls with their transferred counterpart', () => {
  const document = { blocks: [{ id: 'b1', type: 'image', data: { url: 'data:image/png;base64,AAA' } }] };
  const rewritten = rewriteDocument(document, { ids: new Map(), urls: new Map([['data:image/png;base64,AAA', 'https://server.test/files/a1.png']]) });
  expect(JSON.stringify(rewritten)).toContain('https://server.test/files/a1.png');
});

const subtree = [
  { id: 'root', title: 'Guide', parentId: null, icon: '📘' },
  { id: 'leaf', title: 'Détail', parentId: 'root' },
  { id: 'other', title: 'Ailleurs', parentId: null },
];

const mint = (): (() => string) => {
  const names = ['new-root', 'new-leaf'];
  return () => names.shift() ?? 'extra';
};

it('reissues identifiers, re-roots the subtree and follows internal links', async () => {
  const documents: Record<string, unknown> = {
    root: { title: 'Guide', blocks: [{ id: 'b1', type: 'page-link', data: { pageId: 'leaf' } }] },
    leaf: { title: 'Détail', blocks: [{ id: 'b2', type: 'page-link', data: { pageId: 'other' } }] },
  };
  const plan = await planTransfer({
    pages: subtree, sourceId: 'root', parentId: 'destination', mintId: mint(),
    readDocument: id => Promise.resolve(documents[id] ?? null),
    transferAsset: () => Promise.resolve(null),
  });
  expect(plan.pages).toEqual([
    { id: 'new-root', title: 'Guide', parentId: 'destination', icon: '📘' },
    { id: 'new-leaf', title: 'Détail', parentId: 'new-root' },
  ]);
  expect(plan.documents[0]?.document).toEqual({ title: 'Guide', blocks: [{ id: 'b1', type: 'page-link', data: { pageId: 'new-leaf' } }] });
  // A link out of the subtree keeps pointing where it pointed.
  expect(plan.documents[1]?.document).toEqual({ title: 'Détail', blocks: [{ id: 'b2', type: 'page-link', data: { pageId: 'other' } }] });
});

it('refuses a subtree holding a database, naming it', async () => {
  await expect(planTransfer({
    pages: subtree, sourceId: 'root', parentId: null, mintId: mint(),
    readDocument: () => Promise.resolve({ blocks: [{ id: 'b1', type: 'database', data: { title: 'Suivi' } }] }),
    transferAsset: () => Promise.resolve(null),
  })).rejects.toThrow('Suivi');
});

it('transfers each asset once, even when two pages share it', async () => {
  const seen: string[] = [];
  const shared = { blocks: [{ id: 'b1', type: 'image', data: { url: 'data:image/png;base64,AAA' } }] };
  const plan = await planTransfer({
    pages: subtree, sourceId: 'root', parentId: null, mintId: mint(),
    readDocument: () => Promise.resolve(structuredClone(shared)),
    transferAsset: url => { seen.push(url); return Promise.resolve('https://server.test/files/a1.png'); },
  });
  expect(seen).toEqual(['data:image/png;base64,AAA']);
  expect(JSON.stringify(plan.documents)).not.toContain('base64');
});

it('creates a page that never had a document, without a document to write', async () => {
  const plan = await planTransfer({
    pages: [{ id: 'root', title: 'Vide', parentId: null }], sourceId: 'root', parentId: null, mintId: mint(),
    readDocument: () => Promise.resolve(null),
    transferAsset: () => Promise.resolve(null),
  });
  expect(plan.pages).toEqual([{ id: 'new-root', title: 'Vide', parentId: null }]);
  expect(plan.documents).toEqual([]);
});

it('offers each destination workspace, says plainly that it copies, and keeps the dialog open on failure', async () => {
  const onTransfer = vi.fn(() => Promise.reject(new Error('Le serveur a refusé.')));
  openWorkspaceTransfer({
    title: 'Guide',
    workspaces: [{ key: 'local:default', name: 'Espace local', detail: 'Sur cet appareil' },
      { key: 'remote:nexenture', name: 'Nexenture', detail: 'blok.tousamba.cloud' }],
    onTransfer,
  });
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-navigation-transfer] button')];
  expect(buttons.map(button => button.textContent)).toEqual(expect.arrayContaining([
    expect.stringContaining('Espace local'), expect.stringContaining('Nexenture'),
  ]));
  expect(document.querySelector('[data-navigation-transfer]')?.textContent).toContain('copie');

  const nexenture = buttons.find(button => button.textContent?.includes('Nexenture'));
  nexenture?.click();
  await vi.waitFor(() => expect(onTransfer).toHaveBeenCalledWith('remote:nexenture'));
  await vi.waitFor(() => {
    expect(document.querySelector('[data-navigation-transfer-error]')?.textContent).toBe('Le serveur a refusé.');
  });
  expect(document.querySelector('[data-navigation-transfer]')).not.toBeNull();
});

it('inlines a downloaded asset, refuses one too large to embed, and survives a failed download', async () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  await expect(inlineAsset('https://server.test/files/a.png', () => Promise.resolve(png)))
    .resolves.toMatch(/^data:image\/png;base64,/);
  // Embedding is base64 in the document itself: past a point the page becomes the file.
  await expect(inlineAsset('https://server.test/files/b.png', () => Promise.resolve(png), 2)).resolves.toBeNull();
  await expect(inlineAsset('https://server.test/files/c.png', () => Promise.resolve(null))).resolves.toBeNull();
  await expect(inlineAsset('https://server.test/files/d.png', () => Promise.reject(new Error('hors ligne')))).resolves.toBeNull();
});

it('recognises only the source server own files, never an image hosted elsewhere', () => {
  expect(isServerAsset('https://blok.test/files/a1.png', 'https://blok.test')).toBe(true);
  expect(isServerAsset('/files/a1.png', 'https://blok.test')).toBe(true);
  // Another host's image is not ours to download and embed.
  expect(isServerAsset('https://images.example.com/photo.jpg', 'https://blok.test')).toBe(false);
  expect(isServerAsset('https://blok.test/api/other', 'https://blok.test')).toBe(false);
  expect(isServerAsset('data:image/png;base64,AAA', 'https://blok.test')).toBe(false);
  expect(isServerAsset('pas une url', 'https://blok.test')).toBe(false);
});

it('starts every copied page private when the destination is a server', async () => {
  const pages = [{ id: 'root', title: 'Guide', parentId: null }, { id: 'leaf', title: 'Détail', parentId: 'root' }];
  const options = {
    pages, sourceId: 'root', parentId: null,
    readDocument: () => Promise.resolve({ blocks: [] }),
    transferAsset: () => Promise.resolve(null),
  };
  const guarded = await planTransfer({ ...options, mintId: mint(), privateOnArrival: true });
  expect(guarded.pages.map(page => page.initialVisibility)).toEqual(['private', 'private']);
  // A local destination has no such notion; the field must not leak into it.
  const plain = await planTransfer({ ...options, mintId: mint(), privateOnArrival: false });
  expect(plain.pages.some(page => 'initialVisibility' in page)).toBe(false);
});
