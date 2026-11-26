import { DocumentPurged } from '../journal/append.ts';

/** Admission was refused for load reasons, never for permission reasons. */
export class RoomBusy extends Error {
  constructor(message = 'Room busy') { super(message); }
}

interface Closable { close(reason?: { code: number; message: string }): Promise<void> | void }

export interface Resident<Room> {
  room: Promise<Room>;
  users: number;
  /** Set while the writer drains its queue and releases its lease. */
  closing?: Promise<void>;
}

export interface RoomRegistryOptions<Room extends Closable> {
  open: (documentId: string) => Promise<Room>;
  /** Documents held open at once. */
  maxDocuments?: number;
  /** Members admitted to one document. */
  maxUsersPerDocument?: number;
  /** Single-document hosts never unload: the lease is the process lifetime. */
  keepLoaded?: boolean;
}

export interface RoomRegistry<Room extends Closable> {
  reserve(documentId: string): Promise<Resident<Room>>;
  release(documentId: string, entry: Resident<Room>): void;
  /** Serialises reset and purge against admission, per document. */
  exclusive(documentId: string, work: () => Promise<void>): Promise<void>;
  /** `load` opens an absent document so a record replaced underneath the host still releases its lease. */
  retire(documentId: string, reason: { code: number; message: string }, options?: { load?: boolean }): Promise<void>;
  peek(documentId: string): Resident<Room> | undefined;
  /** Snapshot of every registered resident, for host-wide notifications. */
  residents(): Resident<Room>[];
  markPurging(documentId: string): void;
  clearPurging(documentId: string): void;
  loaded(): number;
  /** Resolves once every in-flight unload has finished. Test and shutdown seam. */
  settled(): Promise<void>;
  close(): Promise<void>;
}

export function createRoomRegistry<Room extends Closable>(options: RoomRegistryOptions<Room>): RoomRegistry<Room> {
  const maxDocuments = options.maxDocuments ?? 128;
  const maxUsers = options.maxUsersPerDocument ?? 32;

  const pages = new Map<string, Resident<Room>>();
  const transitions = new Map<string, Promise<void>>();
  const purging = new Set<string>();
  const unloads = new Set<Promise<void>>();
  let stopping = false;

  function load(id: string): Resident<Room> {
    const entry: Resident<Room> = { room: options.open(id), users: 0 };
    pages.set(id, entry);
    // A room that fails to open must not stay registered as if it had.
    void entry.room.catch(() => { if (pages.get(id) === entry) pages.delete(id); });
    return entry;
  }

  function unload(id: string, entry: Resident<Room>): Promise<void> {
    entry.closing ??= entry.room
      .then((room) => room.close())
      .catch(() => {})
      .finally(() => { if (pages.get(id) === entry) pages.delete(id); });

    const tracked = entry.closing.finally(() => unloads.delete(tracked));
    unloads.add(tracked);
    return entry.closing;
  }

  return {
    async reserve(id) {
      let entry: Resident<Room> | undefined;
      for (;;) {
        const transition = transitions.get(id);
        if (transition !== undefined) { await transition.catch(() => {}); continue; }
        if (purging.has(id)) throw new DocumentPurged('Document purge pending');
        entry = pages.get(id);
        if (entry?.closing === undefined) break;
        await entry.closing;
      }

      if (stopping) throw new RoomBusy('Host stopping');
      if (entry === undefined && pages.size >= maxDocuments) throw new RoomBusy();
      if (entry !== undefined && entry.users >= maxUsers) throw new RoomBusy();

      entry ??= load(id);
      entry.users += 1;
      return entry;
    },

    release(id, entry) {
      entry.users -= 1;
      if (entry.users === 0 && !options.keepLoaded) void unload(id, entry);
    },

    exclusive(id, work) {
      const pending = (transitions.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
      transitions.set(id, pending);
      return pending.finally(() => { if (transitions.get(id) === pending) transitions.delete(id); });
    },

    async retire(id, reason, options) {
      let entry = pages.get(id);
      if (entry === undefined) {
        if (options?.load !== true) return;
        if (pages.size >= maxDocuments) throw new RoomBusy();
        entry = load(id);
      }
      if (entry.closing !== undefined) { await entry.closing; return; }
      try {
        const room = await entry.room;
        entry.closing = Promise.resolve(room.close(reason)).then(() => {});
        await entry.closing;
      } finally {
        if (pages.get(id) === entry) pages.delete(id);
      }
    },

    peek: (id) => pages.get(id),
    residents: () => [...pages.values()],
    markPurging: (id) => { purging.add(id); },
    clearPurging: (id) => { purging.delete(id); },
    loaded: () => pages.size,
    settled: async () => { await Promise.all([...unloads]); },

    async close() {
      stopping = true;
      await Promise.all([...pages].map(([id, entry]) => unload(id, entry)));
    },
  };
}
