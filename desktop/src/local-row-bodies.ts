import { readFile, writeFile } from './storage';
import type { PageLocation } from './storage';
import type { ResolvedPage } from './page-urls';
import type { WorkspaceRef } from './workspace-registry';

/**
 * Which row each local body document belongs to.
 *
 * A row's body is a document of its own, but it is not a page of the workspace:
 * it has no place in the sidebar, in search, in the trash or in a move. The
 * server keeps that distinction by excluding `rowBodyOf` pages from the index it
 * serves; a local workspace needs the same separation, so the link lives here
 * rather than in `index.json` — one file to read instead of eight places to
 * filter, and the index keeps meaning "the pages of this workspace".
 */
export interface RowBodyEntry {
  /** Stable across sessions: the URL resolver lowercases it on every lookup. */
  publicId: string;
  /** The document physically holding the row — itself possibly another body. */
  documentId: string;
  rowId: string;
  databaseId?: string;
  title: string;
  icon?: string;
}

export interface RowBodyRegistry {
  load(): Promise<void>;
  get(bodyId: string): RowBodyEntry | undefined;
  list(): Array<{ bodyId: string } & RowBodyEntry>;
  add(bodyId: string, entry: RowBodyEntry): Promise<void>;
  /** Keeps the registry's copy of what the row shows in step with the document. */
  rename(bodyId: string, title: string, icon?: string): Promise<void>;
  remove(bodyId: string): Promise<void>;
  /** The bodies held by this document, so closing it can take them along. */
  childrenOf(documentId: string): Array<{ bodyId: string } & RowBodyEntry>;
  /** The page of the workspace this body ultimately sits in. */
  rootOf(bodyId: string): string;
  /** The chain of rows from that page down to this body, outermost first. */
  rowsOf(bodyId: string): PageLocation['rows'];
  /** The shape the URL resolver expects, built without asking anyone. */
  resolvedPageFor(bodyId: string, workspaceName: string): ResolvedPage | null;
}

const FILE = 'row-bodies';

/** Guards against a registry whose chain loops: a body cannot contain itself. */
const climb = (entries: Map<string, RowBodyEntry>, bodyId: string): string[] => {
  const path: string[] = [];
  const cursor: { id: string | undefined } = { id: bodyId };

  while (cursor.id !== undefined && entries.has(cursor.id) && !path.includes(cursor.id)) {
    path.push(cursor.id);
    cursor.id = entries.get(cursor.id)?.documentId;
  }

  return path;
};

export const createRowBodyRegistry = (ref: WorkspaceRef): RowBodyRegistry => {
  const entries = new Map<string, RowBodyEntry>();
  const persist = async (): Promise<void> => {
    await writeFile(FILE, JSON.stringify(Object.fromEntries(entries)), ref);
  };

  const registry: RowBodyRegistry = {
    async load() {
      const raw = await readFile(FILE, ref).catch(() => null);

      entries.clear();
      if (raw === null) return;

      // A damaged registry costs the row bodies their addresses, not the pages:
      // the workspace still opens, and the bodies are re-registered as they are
      // created again.
      const parsed: unknown = ((): unknown => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })();

      if (parsed === null || typeof parsed !== 'object') return;
      for (const [bodyId, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = value as Partial<RowBodyEntry>;

        if (typeof entry.documentId === 'string' && typeof entry.rowId === 'string') {
          entries.set(bodyId, {
            publicId: typeof entry.publicId === 'string' ? entry.publicId : bodyId,
            documentId: entry.documentId,
            rowId: entry.rowId,
            title: typeof entry.title === 'string' ? entry.title : 'Ligne',
            ...(typeof entry.databaseId === 'string' ? { databaseId: entry.databaseId } : {}),
            ...(typeof entry.icon === 'string' ? { icon: entry.icon } : {}),
          });
        }
      }
    },
    get: (bodyId) => entries.get(bodyId),
    list: () => [...entries].map(([bodyId, entry]) => ({ bodyId, ...entry })),
    async add(bodyId, entry) {
      entries.set(bodyId, entry);
      await persist();
    },
    async rename(bodyId, title, icon) {
      const entry = entries.get(bodyId);

      if (entry === undefined) return;
      const next = title.trim() || entry.title;

      if (next === entry.title && icon === entry.icon) return;
      entries.set(bodyId, { ...entry, title: next, ...(icon === undefined ? {} : { icon }) });
      await persist();
    },
    async remove(bodyId) {
      if (!entries.delete(bodyId)) return;
      await persist();
    },
    childrenOf: (documentId) => [...entries]
      .filter(([, entry]) => entry.documentId === documentId)
      .map(([bodyId, entry]) => ({ bodyId, ...entry })),
    rootOf: (bodyId) => {
      const path = climb(entries, bodyId);
      const outermost = path.at(-1);

      return outermost === undefined ? bodyId : entries.get(outermost)?.documentId ?? bodyId;
    },
    rowsOf: (bodyId) => climb(entries, bodyId).reverse().flatMap((id) => {
      const entry = entries.get(id);

      return entry === undefined ? [] : [{
        documentId: entry.documentId,
        rowId: entry.rowId,
        ...(entry.databaseId === undefined ? {} : { databaseId: entry.databaseId }),
        title: entry.title,
        ...(entry.icon === undefined ? {} : { icon: entry.icon }),
      }];
    }),
    resolvedPageFor: (bodyId, workspaceName) => {
      const entry = entries.get(bodyId);

      if (entry === undefined) return null;

      return {
        pageId: bodyId,
        publicId: entry.publicId,
        title: entry.title,
        workspace: { id: ref.id, slug: ref.id, name: workspaceName } as ResolvedPage['workspace'],
        teamspaceId: null,
        rowBodyOf: { documentId: entry.documentId, rowId: entry.rowId },
        location: {
          documentId: registry.rootOf(bodyId),
          blockId: entry.rowId,
          blockDocumentId: entry.documentId,
          rows: registry.rowsOf(bodyId),
        },
      };
    },
  };

  return registry;
};
