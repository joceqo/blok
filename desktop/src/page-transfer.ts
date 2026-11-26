/**
 * Copying a page from one workspace into another.
 *
 * The two stores are disjoint — files on disk here, a collaborative document on
 * a server there — so nothing can span them transactionally. A transfer reads
 * the source, writes the destination, and only then may the source be trashed.
 *
 * Identifiers are reissued rather than reused: the destination may already hold
 * the source's ids, and a second transfer of the same page would otherwise
 * overwrite the first. Links inside the subtree follow the new ids; links out
 * of it keep pointing where they pointed.
 */

/** Keys whose string value addresses an uploaded file, wherever a tool stores it. */
const ASSET_KEYS = new Set(['url', 'src']);
/** Keys whose string value may carry a page identifier inside a link. */
const HREF_KEYS = new Set(['href', 'link']);

/** Addresses reach us from stored documents: never assume one parses. */
function parsed(value: string, base?: string): URL | null {
  try { return new URL(value, base); } catch { return null; }
}

export interface TransferTables {
  ids: ReadonlyMap<string, string>;
  urls: ReadonlyMap<string, string>;
}

type Hierarchical = { id: string; parentId: string | null };

function grow<T extends Hierarchical>(pages: readonly T[], collected: readonly T[], ids: Set<string>): T[] {
  const added = pages.filter((page) => !ids.has(page.id) && page.parentId !== null && ids.has(page.parentId));
  if (added.length === 0) return [...collected];
  added.forEach((page) => ids.add(page.id));
  return grow(pages, [...collected, ...added], ids);
}

/** The source and everything under it, parents before children. Tolerates a cycle. */
export function transferSubtree<T extends Hierarchical>(pages: readonly T[], sourceId: string): T[] {
  const source = pages.find((page) => page.id === sourceId);
  if (!source) return [];
  return grow(pages, [source], new Set([source.id]));
}

/**
 * The title of the first database in the document, or null when there is none.
 *
 * A database owns row bodies the index projects read-only, and reissuing their
 * containment is a separate piece of work. Until it exists a transfer refuses
 * rather than writing a database whose rows stayed behind.
 */
export function blockingDatabase(document: unknown): string | null {
  if (typeof document !== 'object' || document === null || !('blocks' in document) || !Array.isArray(document.blocks)) return null;
  const database = (document.blocks as unknown[]).find((block) =>
    typeof block === 'object' && block !== null && 'type' in block && block.type === 'database');
  if (database === undefined) return null;
  const data = typeof database === 'object' && database !== null && 'data' in database ? database.data : null;
  const title = typeof data === 'object' && data !== null && 'title' in data && typeof data.title === 'string' ? data.title.trim() : '';
  return title || 'Base de données';
}

function rewriteHref(href: string, ids: ReadonlyMap<string, string>): string {
  const [, identity] = /^blok:\/\/page\/([^/?#]+)/.exec(href) ?? [];
  if (identity !== undefined) {
    const next = ids.get(identity);
    return next === undefined ? href : `blok://page/${next}${href.slice(`blok://page/${identity}`.length)}`;
  }
  // An absolute link addresses another host's page, or this one seen from
  // outside: either way its identifier is not ours to reissue.
  if (href.includes('://')) return href;
  try {
    const url = new URL(href, 'https://workspace.invalid');
    const next = ids.get(url.searchParams.get('page') ?? '');
    if (next === undefined) return href;
    url.searchParams.set('page', next);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return href; }
}

/** Every asset address the document carries, in reading order, each once. */
export function assetUrls(document: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value !== 'object' || value === null) return;
    Object.entries(value).forEach(([key, item]) => {
      if (ASSET_KEYS.has(key) && typeof item === 'string' && item !== '') { if (!found.includes(item)) found.push(item); return; }
      walk(item);
    });
  };
  walk(document);
  return found;
}

/** A copy of the document with transferred identifiers and assets. The original is untouched. */
export function rewriteDocument(document: unknown, tables: TransferTables): unknown {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (typeof item === 'string') {
        if (key === 'pageId') return [key, tables.ids.get(item) ?? item];
        if (ASSET_KEYS.has(key)) return [key, tables.urls.get(item) ?? item];
        if (HREF_KEYS.has(key)) return [key, rewriteHref(item, tables.ids)];
      }
      return [key, walk(item)];
    }));
  };
  return walk(document);
}

export interface TransferablePage { id: string; title: string; parentId: string | null; icon?: string; initialVisibility?: 'private' }

export interface TransferPlan {
  /** Index entries to create in the destination, parents before children. */
  pages: TransferablePage[];
  /** Documents to write once those entries exist — `seed` refuses a page it cannot find. */
  documents: Array<{ id: string; document: unknown }>;
}

export class DatabaseInTransferError extends Error {
  public constructor(public readonly database: string) {
    super(`« ${database} » est une base de données. Son transfert entre espaces n’est pas encore pris en charge : les corps de ses lignes resteraient en arrière.`);
    this.name = 'DatabaseInTransferError';
  }
}

/**
 * What to create in the destination for a copy of `sourceId` and everything under it.
 *
 * Nothing is written here. The caller owns the order, and the order is imposed
 * by the server: `seed` only fills a page that already exists, whose content is
 * still null and whose collaboration never started. So the index entries go
 * first, and the documents follow.
 *
 * @param options.transferAsset - stores one asset in the destination and returns
 *   its new address, or null to leave the reference untouched.
 */
export async function planTransfer(options: {
  pages: readonly TransferablePage[];
  sourceId: string;
  parentId: string | null;
  mintId: () => string;
  /**
   * Whether the copies start private. A server destination says yes: the source
   * may have been private, and its sharing does not travel, so inheriting the
   * destination's default would hand the content to everyone who can see that
   * workspace. An extra share is cheap; an accidental disclosure is not.
   */
  privateOnArrival?: boolean;
  readDocument: (id: string) => Promise<unknown>;
  transferAsset: (url: string) => Promise<string | null>;
}): Promise<TransferPlan> {
  const subtree = transferSubtree(options.pages, options.sourceId);
  if (subtree.length === 0) return { pages: [], documents: [] };

  const sources = await Promise.all(subtree.map(async (page) => ({ page, document: await options.readDocument(page.id) })));
  const blocked = sources.map((entry) => blockingDatabase(entry.document)).find((name) => name !== null);
  if (blocked !== undefined && blocked !== null) throw new DatabaseInTransferError(blocked);

  const ids = new Map(subtree.map((page) => [page.id, options.mintId()]));
  const encountered = [...new Set(sources.flatMap((entry) => assetUrls(entry.document)))];
  const moved = await Promise.all(encountered.map(async (url) => [url, await options.transferAsset(url)] as const));
  const urls = new Map(moved.filter((entry): entry is readonly [string, string] => entry[1] !== null));

  return {
    pages: subtree.map((page) => ({
      id: ids.get(page.id) ?? page.id,
      title: page.title,
      parentId: page.id === options.sourceId ? options.parentId : ids.get(page.parentId ?? '') ?? options.parentId,
      ...(page.icon === undefined ? {} : { icon: page.icon }),
      ...(options.privateOnArrival === true ? { initialVisibility: 'private' as const } : {}),
    })),
    documents: sources.filter((entry) => entry.document !== null && entry.document !== undefined).map((entry) => ({
      id: ids.get(entry.page.id) ?? entry.page.id,
      document: rewriteDocument(entry.document, { ids, urls }),
    })),
  };
}

/**
 * How much of an asset may be embedded in a document.
 *
 * Inlining stores the bytes as base64 inside the page itself, so past a point
 * the page becomes the file: slow to load, slow to save, and carried whole on
 * every write. Beyond this the reference is left alone instead.
 */
export const ASSET_INLINE_LIMIT = 4_000_000;

/**
 * Downloads an asset and turns it into a data URL.
 *
 * A server-hosted asset is reachable only to whoever can reach that server, so
 * a copy that keeps the address loses its images the moment access does. Taking
 * the bytes along is what makes the copy stand on its own.
 *
 * @returns the data URL, or null when it could not be fetched or is too large —
 *   in both cases the caller keeps the original reference rather than losing it.
 */
export async function inlineAsset(
  url: string,
  fetchAsset: (url: string) => Promise<Blob | null>,
  limit: number = ASSET_INLINE_LIMIT,
): Promise<string | null> {
  const blob = await fetchAsset(url).catch(() => null);
  if (blob === null || blob.size === 0 || blob.size > limit) return null;
  return await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** Whether this address is a file the given server hosts itself. */
export function isServerAsset(url: string, origin: string): boolean {
  const asset = parsed(url, origin);
  return asset !== null && asset.origin === origin && asset.pathname.startsWith('/files/');
}
