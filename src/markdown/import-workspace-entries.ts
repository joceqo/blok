import { parseFragment, serialize, type ChildNode } from '../html';
import { richTextFieldsFor } from '../shared/rich-text/fields';
import { importWorkspaceFile } from './import-workspace-file';
import type { LooseOutputBlockData, LooseOutputData } from '../../types/data-formats/output-data';

export interface ImportedPage {
  id: string;
  parentId: string | null;
  document: LooseOutputData & { title: string };
}

const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const folder = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const withoutExtension = (path: string) => path.replace(/\.[^./]+$/, '');
const display = (path: string) =>
  leaf(path)
    .replace(/\s+[a-f\d]{32}$/i, '')
    .trim() || 'Sans titre';
const isPage = (path: string) => /\.(?:md|markdown|csv|html?)$/i.test(path);
const types: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};

function resolve(from: string, href: string) {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(href)) return;
  const parts = folder(from).split('/').filter(Boolean);
  try {
    for (const part of decodeURIComponent(href.split(/[?#]/)[0]).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return;
        parts.pop();
      } else parts.push(part);
    }
    return parts.join('/').normalize('NFC');
  } catch {
    return;
  }
}

export const MAX_EXPANDED_BYTES = 128 << 20;
export interface ImportEntry {
  name: string;
  size: number;
  text(): string | Promise<string>;
  base64(): string | Promise<string>;
}

// The host owns ZIP decoding and ID generation. Document conversion and link repair
// are identical in the desktop, Node, and the Go server's embedded runtime.
export async function importWorkspaceEntries(
  entries: ImportEntry[], name: string, rootId: string,
  pageId: (path: string) => string | Promise<string>, newId: () => string,
): Promise<ImportedPage[]> {
  const notionExport = entries.some((e) => / [a-f\d]{32}\.(?:md|csv|html)$/i.test(e.name));
  const files = new Map(
    entries
      .filter((e) => !(notionExport && e.name === 'index.html'))
      .map((e) => [e.name.normalize('NFC'), e]),
  );
  const documents = [...files.keys()].filter(isPage);
  if (documents.some((path) => path.split('/').length > 60 || path.length > 4096))
    throw new Error('Le chemin d’une page dépasse les limites de cet espace.');
  if (!documents.length)
    throw new Error('Cette archive ne contient aucune page Markdown, HTML ou CSV.');
  const pages: ImportedPage[] = [
    {
      id: rootId,
      parentId: null,
      document: { title: display(withoutExtension(name)), blocks: [] },
    },
  ];
  const ids = new Map<string, string>();
  // Stable within this archive attempt, including after a partial disk write.
  async function add(path: string, title: string) {
    const id = await pageId(path);
    ids.set(path, id);
    const page: ImportedPage = { id, parentId: null, document: { title, blocks: [] } };
    pages.push(page);
    return page;
  }
  const byPath = new Map<string, ImportedPage>();
  const directories = new Map<string, ImportedPage>();
  for (const path of documents) {
    const page = await add(path, display(withoutExtension(path)));
    byPath.set(path, page);
    directories.set(withoutExtension(path), page);
  }
  const folders = new Set<string>();
  for (const path of documents) {
    for (let dir = folder(path); dir; dir = folder(dir)) folders.add(dir);
  }
  for (const dir of folders)
    if (!directories.has(dir)) directories.set(dir, await add(dir + '/', display(dir)));
  for (const [dir, page] of directories)
    page.parentId = (directories.get(folder(dir)) ?? pages[0]).id;
  for (const [path, page] of byPath) page.parentId = (directories.get(folder(path)) ?? pages[0]).id;

  const assets = new Map<string, string>();
  let embeddedBytes = 0;
  async function mediaUrl(path: string) {
    const entry = files.get(path)!;
    embeddedBytes += entry.size;
    if (embeddedBytes > MAX_EXPANDED_BYTES)
      throw new Error('Les pièces jointes dépassent 128 Mio une fois intégrées aux pages.');
    let url = assets.get(path);
    if (!url) {
      const extension = path.split('.').pop()!.toLowerCase();
      const mime = Object.hasOwn(types, extension) ? types[extension] : 'application/octet-stream';
      url = 'data:' + mime + ';base64,' + (await entry.base64());
      assets.set(path, url);
    }
    return url;
  }
  async function attachment(path: string): Promise<LooseOutputBlockData> {
    const url = await mediaUrl(path);
    const kind = url.match(/^data:(image|audio|video)\//)?.[1] ?? 'file';
    return { id: newId(), type: kind, data: { url, fileName: leaf(path) } };
  }
  async function repairInline(html: string, path: string, extra: LooseOutputBlockData[]) {
    const tree = parseFragment(html);
    const queue: ChildNode[] = [...tree.childNodes];
    while (queue.length) {
      const node = queue.pop()!;
      if (!('tagName' in node)) continue;
      queue.push(...node.childNodes);
      const attr = node.attrs.find(
        (a) =>
          (node.tagName === 'a' && a.name === 'href') ||
          (node.tagName === 'img' && a.name === 'src'),
      );
      const target = attr && resolve(path, attr.value);
      if (!attr || !target || !files.has(target)) continue;
      const pageId = ids.get(target);
      if (pageId && node.tagName === 'a') {
        node.attrs = [{ name: 'data-blok-page-id', value: pageId }];
        node.childNodes = [{ nodeName: '#text', value: 'Page', parentNode: node }];
      } else if (!pageId && node.tagName === 'img') attr.value = await mediaUrl(target);
      else if (!pageId) {
        extra.push(await attachment(target));
        node.attrs = [];
      }
    }
    return serialize(tree);
  }
  for (const [path, page] of byPath) {
    const ext = path.slice(path.lastIndexOf('.'));
    const doc = await importWorkspaceFile(
      page.document.title + ext,
      await files.get(path)!.text(),
      newId,
    );
    const extra: LooseOutputBlockData[] = [];
    for (const block of doc.blocks) {
      if (!block.data) continue;
      if (typeof block.data.url === 'string') {
        const target = resolve(path, block.data.url);
        if (target && files.has(target) && !byPath.has(target))
          block.data.url = await mediaUrl(target);
      }
      for (const field of richTextFieldsFor(block.type)) {
        const text = block.data[field];
        if (typeof text === 'string' && /<(?:a|img)\b/i.test(text))
          block.data[field] = await repairInline(text, path, extra);
      }
    }
    page.document = { ...doc, blocks: [...doc.blocks, ...extra] };
  }
  // Notion full-page databases put each row body in a sibling folder.
  for (const [path, database] of byPath) {
    if (!/\.csv$/i.test(path)) continue;
    const rows = new Map<string, LooseOutputBlockData | null>();
    for (const row of database.document.blocks)
      if (row.type === 'database-row' && typeof row.data?.title === 'string') {
        rows.set(row.data.title, rows.has(row.data.title) ? null : row);
      }
    for (const child of byPath.values()) {
      if (child.parentId !== database.id) continue;
      const row = rows.get(child.document.title);
      if (row?.data && !row.data.pageId) row.data.pageId = child.id;
    }
  }
  const pageById = new Map(pages.map((p) => [p.id, p]));
  for (const page of pages)
    if (page.parentId)
      pageById.get(page.parentId)!.document.blocks.push({
        id: newId(),
        type: 'page',
        data: { pageId: page.id },
      });
  // Unlinked attachments still belong to the migration. Keep them on its landing page.
  for (const path of files.keys())
    if (!byPath.has(path) && !assets.has(path))
      pages[0].document.blocks.push(await attachment(path));
  return pages;
}
