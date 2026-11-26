import { DocumentStore } from '../../src/components/modules/yjs/document-store';
import { readPageFields } from '../../src/components/modules/yjs/page-fields';
import { createLocalSyncHub, type LocalRoomStorage, type LocalSyncHub } from '../../src/components/modules/collaboration/local-room';
import { YBlockSerializer } from '../../src/components/modules/yjs/serializer';
import type { OutputData } from '../../types';

import { createDesktopRoomLink } from './local-sync-bridge';

/**
 * Opt-in while the local collaboration path is being proven. Without it a local
 * workspace keeps rewriting its page files, guard and all.
 *
 * Read from storage as well as the query string: a desktop window has no address
 * bar to type a flag into, so switching it on means one line in the console and
 * a reload — `localStorage.setItem('blok:local-collab', '1')`.
 */
export const localCollabEnabled = (): boolean => {
  if (new URLSearchParams(location.search).get('local-collab') === '1') {
    return true;
  }

  try {
    return localStorage.getItem('blok:local-collab') === '1';
  } catch {
    // A window denied storage still runs; it just cannot carry the flag.
    return false;
  }
};

interface PageFile {
  read(id: string): Promise<string | null>;
  write(id: string, data: string): Promise<void>;
  /** The title the index holds, for a file written before titles lived in it. */
  title?(id: string): string | undefined;
  /**
   * Moves the bodies of this page's rows into documents of their own, before
   * the room takes the page. Under collaboration the room is the only writer,
   * so the move has to happen on the way in or not at all.
   */
  migrate?(id: string, data: OutputData): Promise<OutputData>;
}

const storeFromBlocks = (blocks: OutputData['blocks']): DocumentStore => {
  const store = new DocumentStore(new YBlockSerializer());

  store.fromJSON(blocks.map((block) => ({
    id: block.id ?? crypto.randomUUID(),
    type: block.type,
    data: block.data,
    ...(block.parent === undefined ? {} : { parent: block.parent }),
    ...(block.content === undefined ? {} : { content: block.content }),
  })));

  return store;
};

/**
 * A room's document, kept in the page file it already lives in.
 *
 * The file stays the JSON every other local reader expects — the outline, a
 * duplicate, the agent's file mode. Only the blocks are replaced on save, so a
 * field this path does not model survives rather than being dropped.
 */
const pageStorage = (files: PageFile): LocalRoomStorage => ({
  async load(doc) {
    const raw = await files.read(doc);

    if (raw === null) {
      return null;
    }

    const stored = JSON.parse(raw) as OutputData;
    const data = await files.migrate?.(doc, stored) ?? stored;
    const store = storeFromBlocks(data.blocks ?? []);

    // The title, icon and cover belong to the shared document too. Left out,
    // the editor opens a page with no title and writes that emptiness back over
    // the name the index holds.
    store.pageFromJSON({
      title: data.title ?? files.title?.(doc),
      ...(data.icon === undefined ? {} : { icon: data.icon }),
      ...(data.cover === undefined ? {} : { cover: data.cover }),
    });

    return store.encodeStateAsUpdate();
  },
  async save(doc, state) {
    const store = new DocumentStore(new YBlockSerializer());

    store.applyRemoteUpdate(state);

    const raw = await files.read(doc);
    const existing = raw === null ? {} : JSON.parse(raw) as Partial<OutputData>;
    const fields = readPageFields(store.page);

    await files.write(doc, JSON.stringify({
      ...existing,
      ...fields,
      blocks: store.toJSON(),
      time: Date.now(),
    }));
  },
});

/**
 * The sync service of a local workspace: one relay per window, linked to the
 * other windows through the native side, persisting to the page files.
 */
export const createLocalCollab = (workspace: string, files: PageFile): LocalSyncHub => {
  const link = createDesktopRoomLink(workspace);

  return createLocalSyncHub({ storage: pageStorage(files), ...(link === null ? {} : { link }) });
};
