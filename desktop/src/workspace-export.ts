import { richTextFieldsFor } from '../../src/shared/rich-text/fields';
import { segmentsToHtml } from '../../src/shared/rich-text/segments-to-html';
import { downloadZip } from 'client-zip';
import { blocksToHtml, blocksToMarkdown } from '@bloklabs/core/view';
import type { LooseOutputBlockData, LooseOutputData } from '../../types/data-formats/output-data';
import { ComputedProperties } from '../../src/shared/database/computed-properties';
import { DatabaseModel } from '../../src/tools/database/database-model';
import { csvCellText, serializeCsv } from '../../src/tools/database/database-csv';
import { filesOf, readPropertyValue } from '../../src/shared/database/value-helpers';
import { visibleRowPropertyIds } from '../../src/shared/database/view-properties';
import type {
  DatabaseRowData,
  DatabaseSourceRef,
  DatabaseData,
} from '../../src/shared/database/types';
import type { workspaceRepository } from './workspace-repository';
import type { WorkspaceIndex } from './storage';
import { shellText } from './shell-i18n';

export interface ExportOptions {
  format: 'md' | 'html';
  views: 'current' | 'all';
  attachments: boolean;
  privatePages: boolean;
  folders: boolean;
}
export type ExportWorkspace = (options: ExportOptions, signal: AbortSignal) => Promise<Blob>;
type Repository = Pick<
  ReturnType<typeof workspaceRepository>,
  'loadExportIndex' | 'readExportPage' | 'assetUrl' | 'ref'
>;
type Entry = { name: string; input: string | Blob };

export const fileStem = (title: string) =>
  Array.from(title.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-'))
    .slice(0, 64)
    .join('')
    .replace(/^[. ]+|[. ]+$/g, '') || 'Blok';

function pagePaths(index: WorkspaceIndex, options: ExportOptions, remote: boolean) {
  const names = new Map(
    index.pages.map((page, i) => [page.id, `${i + 1}-${fileStem(page.title)}`]),
  );
  const pages = new Map(index.pages.map((page) => [page.id, page]));
  const paths = new Map<string, string>();
  for (const page of index.pages) {
    if (remote && !options.privatePages && index.access?.[page.id]?.visibility !== 'workspace')
      continue;
    const ancestors = new Set<string>();
    let current: typeof page | undefined = page;
    let excluded = false;
    while (current && !ancestors.has(current.id)) {
      if (!remote && !options.privatePages && current.initialVisibility === 'private')
        excluded = true;
      ancestors.add(current.id);
      current = current.parentId ? pages.get(current.parentId) : undefined;
      // A shared child may have an explicitly public scope under a private parent.
      if (
        remote &&
        current &&
        !options.privatePages &&
        index.access?.[current.id]?.visibility !== 'workspace'
      )
        break;
    }
    if (!excluded) {
      const chain = options.folders ? [...ancestors].reverse() : [page.id];
      paths.set(page.id, chain.map((id) => names.get(id)).join('/') + '.' + options.format);
    }
  }
  return paths;
}

function relative(from: string, to: string) {
  const origin = from.split('/').slice(0, -1);
  const target = to.split('/');
  while (origin.length && origin[0] === target[0]) {
    origin.shift();
    target.shift();
  }
  return (
    (origin.length ? '../'.repeat(origin.length) : './') +
    target
      .map((part) =>
        encodeURIComponent(part).replace(/[()']/g, (c) => '%' + c.charCodeAt(0).toString(16)),
      )
      .join('/')
  );
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const media = new Set(['image', 'video', 'file', 'audio', 'pdf']);
const extensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

export async function exportWorkspace(
  repo: Repository,
  options: ExportOptions,
  signal: AbortSignal,
): Promise<Blob> {
  const index = await repo.loadExportIndex(signal);
  const remote = repo.ref.kind === 'remote' ? repo.ref.server : null;
  const paths = pagePaths(index, options, remote !== null);
  if (!paths.size) throw new Error(shellText('Aucune page ne correspond à ces options.'));
  const pages = new Map(index.pages.map((page) => [page.id, page]));
  const assets = new Map<string, string>();

  async function asset(url: string, label: string, from: string, entries: Entry[]) {
    const embedded = url.startsWith('data:');
    let source = url;
    if (!embedded) {
      if (!remote || !URL.canParse(url, remote)) return url;
      const owned = new URL(url, remote);
      if (owned.origin !== remote || !owned.pathname.startsWith('/files/')) return url;
      source = owned.origin + owned.pathname;
    }
    let path = assets.get(source);
    if (!path) {
      const response = await fetch(embedded ? source : await repo.assetUrl(source), {
        signal,
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(shellText('Impossible de lire une pièce jointe.'));
      const blob = await response.blob();
      const name = fileStem(
        label || (embedded ? 'media' : new URL(source).pathname.split('/').pop()!),
      );
      const ext = extensions[blob.type.split(';')[0]];
      path = `attachments/${assets.size + 1}-${name}${ext && !/\.[a-z0-9]{1,8}$/i.test(name) ? '.' + ext : ''}`;
      assets.set(source, path);
      entries.push({ name: path, input: blob });
    }
    return relative(from, path);
  }

  async function* renderPage(
    path: string,
    titleText: string,
    document: LooseOutputData | null,
    cover?: string,
  ): AsyncGenerator<Entry> {
    const source = document?.blocks ?? [];
    const blocks: LooseOutputBlockData[] = [];
    const entries: Entry[] = [];
    const rows = new Set(
      source.filter((block) => block.type === 'database-row').map((block) => block.id),
    );
    const parents = new Map(source.map((block) => [block.id, block.parent]));
    for (const block of source) {
      for (const child of block.content ?? [])
        if (!parents.get(child)) parents.set(child, block.id);
    }
    const childrenByParent = new Map<string, LooseOutputBlockData[]>();
    for (const block of source) {
      const parent = parents.get(block.id);
      if (parent) {
        const children = childrenByParent.get(parent) ?? [];
        children.push(block);
        childrenByParent.set(parent, children);
      }
    }
    for (const [i, block] of source.entries()) {
      signal.throwIfAborted();
      // Row bodies belong to their row. Never render descendants of a hidden row as loose paragraphs.
      let parent = parents.get(block.id);
      const seen = new Set<string>();
      while (parent && !rows.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        parent = parents.get(parent);
      }
      if (block.type === 'database-row' || (parent && rows.has(parent))) continue;
      const data = { ...block.data };
      if (block.type === 'database') {
        const linked = data.source as DatabaseSourceRef | undefined;
        if (linked?.documentId && !paths.has(linked.documentId)) continue;
        const origin = linked?.documentId
          ? ((await repo.readExportPage(linked.documentId, options.privatePages, signal))?.blocks ??
            [])
          : source;
        const definition = linked
          ? origin.find((b) => b.id === linked.databaseId && b.type === 'database')
          : block;
        if (!definition) continue;
        const databaseId = definition.id ?? String(i);
        const model = new DatabaseModel(
          {
            ...definition.data,
            ...data,
            schema: (definition.data as Partial<DatabaseData> | undefined)?.schema,
          },
          {
            databaseId,
            me: () => (repo.ref.kind === 'remote' ? repo.ref.accountId : null),
          },
        );
        const computed = new ComputedProperties(databaseId);
        model.setValueProperty((p) => computed.valueProperty(p));
        const schema = model.getSchema();
        const title = schema.find((p) => p.type === 'title');
        const children = new Set(definition.content ?? []);
        const databaseRows = origin
          .filter(
            (row) =>
              row.type === 'database-row' &&
              row.id &&
              (row.parent === definition.id || children.has(row.id)) &&
              !row.data?.template,
          )
          .map((row) => {
            const data = row.data as Partial<DatabaseRowData> | undefined;
            const properties = { ...data?.properties };
            if (title && data?.title !== undefined) properties[title.id] = data.title;
            const meta = {
              createdAt: row.createdAt,
              lastEditedAt: row.lastEditedAt,
              ...(data?.anonymous
                ? { anonymous: true as const }
                : { createdBy: row.createdBy, lastEditedBy: row.lastEditedBy }),
            };
            return { id: row.id!, properties, position: data?.position ?? '', meta };
          });
        model.setRows(computed.apply(schema, databaseRows, { databaseId, now: new Date() }));
        const views = model.getTabViews();
        const active = views.find((view) => view.id === data.activeViewId) ?? views[0];
        const links: string[] = [];
        const visibleRows = new Map<string, string>();
        for (const [j, view] of (options.views === 'current' ? [active] : views).entries()) {
          if (!view) continue;
          const columns = [
            title,
            ...visibleRowPropertyIds(view, schema).map((id) => schema.find((p) => p.id === id)),
          ].filter((p) => p !== undefined);
          const name = String(data.title || 'Database') + ' - ' + view.name;
          const csv =
            path.slice(0, path.lastIndexOf('.')) + `-db${i + 1}-v${j + 1}-${fileStem(name)}.csv`;
          const table = [columns.map((p) => p.name)];
          for (const row of model.queryRows({ view }).rows) {
            visibleRows.set(
              row.id,
              String(title ? (readPropertyValue(row, title) ?? 'Row') : 'Row'),
            );
            const cells: string[] = [];
            for (const p of columns) {
              const value = readPropertyValue(row, p);
              if (p.type === 'files') {
                const urls: string[] = [];
                if (options.attachments)
                  for (const file of filesOf(value ?? null))
                    urls.push(await asset(file.url, file.name ?? '', csv, entries));
                cells.push(urls.join(', '));
              } else
                cells.push(
                  csvCellText(computed.valueProperty(p), value, { locale: navigator.language }),
                );
            }
            table.push(cells);
          }
          entries.push({ name: csv, input: serializeCsv(table) });
          links.push(`<a href="${relative(path, csv)}">${escapeHtml(name)}</a>`);
        }
        if (!linked) {
          for (const [rowId, rowTitle] of visibleRows) {
            const body: LooseOutputBlockData[] = [];
            const pending = [...(childrenByParent.get(rowId) ?? [])].reverse();
            const visited = new Set([rowId, block.id]);
            while (pending.length) {
              const child = pending.pop()!;
              if (child.id && visited.has(child.id)) continue;
              visited.add(child.id);
              body.push(parents.get(child.id) === rowId ? { ...child, parent: null } : child);
              if (child.id) pending.push(...[...(childrenByParent.get(child.id) ?? [])].reverse());
            }
            if (body.length) {
              const rowPath =
                path.slice(0, path.lastIndexOf('.')) +
                `-db${i + 1}-row${links.length + 1}-${fileStem(rowTitle)}.${options.format}`;
              yield* renderPage(rowPath, rowTitle, { blocks: body });
              links.push(`<a href="${relative(path, rowPath)}">${escapeHtml(rowTitle)}</a>`);
            }
          }
        }
        blocks.push({
          ...block,
          type: 'paragraph',
          content: [],
          data: { text: links.join('<br>') },
        });
      } else if (media.has(block.type)) {
        if (!options.attachments) continue;
        if (typeof data.url === 'string')
          data.url = await asset(data.url, String(data.fileName || ''), path, entries);
        if (Array.isArray(data.variants)) {
          for (const variant of data.variants)
            if (typeof variant?.url === 'string')
              variant.url = await asset(variant.url, '', path, entries);
        }
        blocks.push({ ...block, data });
      } else {
        for (const field of richTextFieldsFor(block.type)) {
          const value = data[field];
          const html = Array.isArray(value) ? segmentsToHtml(value) : value;
          if (typeof html !== 'string' || !/<(?:img|a)\b/i.test(html)) continue;
          const fragment = window.document.createElement('template');
          fragment.innerHTML = html;
          for (const node of Array.from(fragment.content.querySelectorAll('img[src], a[href]'))) {
            const image = node.tagName === 'IMG';
            const key = image ? 'src' : 'href';
            const url = node.getAttribute(key)!;
            if (options.attachments) node.setAttribute(key, await asset(url, '', path, entries));
            else if (image) node.replaceWith(node.getAttribute('alt') || '');
            else if (
              url.startsWith('data:') ||
              (remote &&
                URL.canParse(url, remote) &&
                new URL(url, remote).origin === remote &&
                new URL(url, remote).pathname.startsWith('/files/'))
            )
              node.removeAttribute(key);
          }
          data[field] = fragment.innerHTML;
        }
        blocks.push({ ...block, data });
      }
    }
    cover = document?.cover?.type === 'image' ? document.cover.url : cover;
    if (options.attachments && cover && /^(?:https?:|data:|\/files\/)/i.test(cover)) {
      blocks.unshift({ type: 'image', data: { url: await asset(cover, 'cover', path, entries) } });
    }
    let icon = document?.icon;
    if (icon?.type === 'image')
      icon = options.attachments
        ? { ...icon, url: await asset(icon.url, 'icon', path, entries) }
        : null;
    yield* entries;
    const render = {
      title: true,
      pageInfo: (id: string) =>
        paths.has(id) ? { title: pages.get(id)!.title } : { access: 'none' as const },
      pageHref: (id: string) => (paths.has(id) ? relative(path, paths.get(id)!) : ''),
    };
    const output = { title: titleText, icon, blocks };
    yield {
      name: path,
      input:
        options.format === 'md'
          ? blocksToMarkdown(output, render)
          : '<!doctype html><meta charset="utf-8"><title>' +
            escapeHtml(titleText) +
            '</title>' +
            blocksToHtml(output, render),
    };
  }

  async function* files(): AsyncGenerator<Entry> {
    for (const [id, path] of paths) {
      signal.throwIfAborted();
      const document = await repo.readExportPage(id, options.privatePages, signal);
      const page = pages.get(id)!;
      yield* renderPage(path, page.title, document, page.cover);
    }
  }
  return downloadZip(files()).blob();
}
