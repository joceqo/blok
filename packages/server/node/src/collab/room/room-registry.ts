import { DocumentPurged } from '../journal/append.ts';

/** Admission was refused for load reasons, never for permission reasons. */
export class RoomBusy extends Error {
  constructor(message = 'Room busy') { super(message); }
}

interface Closable {
  close(reason?: { code: number; message: string }): Promise<void> | void;
  /** False once the room can no longer serve its document, and never true again. */
  available?(): boolean;
}

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
  /**
   * How long a document stays loaded — holding its journal lease — after its
   * last member leaves. Go's `EvictionLinger`, armed by the same rule: only at
   * the step down to zero, and disarmed by the next member to arrive. Zero
   * unloads on that step, which is what a host that wants to hold no lease
   * between requests asks for.
   */
  evictionLingerMs?: number;
  /**
   * Told once a document has left the registry, so a host can drop the
   * bookkeeping it keeps beside it. A linger means the step down to zero
   * members is no longer when that happens.
   */
  onUnloaded?: (documentId: string) => void;
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
  const linger = options.evictionLingerMs ?? 0;

  const pages = new Map<string, Resident<Room>>();
  const transitions = new Map<string, Promise<void>>();
  const purging = new Set<string>();
  const unloads = new Set<Promise<void>>();
  /** One armed linger per document waiting to be evicted. */
  const evictions = new Map<string, ReturnType<typeof setTimeout>>();
  let stopping = false;

  /** Drops the document from the registry, and tells the host it is gone. */
  function forget(id: string, entry: Resident<Room>) {
    if (pages.get(id) !== entry) return;
    disarm(id);
    pages.delete(id);
    options.onUnloaded?.(id);
  }

  function disarm(id: string) {
    const timer = evictions.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    evictions.delete(id);
  }

  function load(id: string): Resident<Room> {
    const entry: Resident<Room> = { room: options.open(id), users: 0 };
    pages.set(id, entry);
    // A room that fails to open must not stay registered as if it had.
    void entry.room.catch(() => forget(id, entry));
    return entry;
  }

  function unload(id: string, entry: Resident<Room>): Promise<void> {
    disarm(id);
    entry.closing ??= entry.room
      .then((room) => room.close())
      .catch(() => {})
      .finally(() => forget(id, entry));

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
        if (entry?.closing !== undefined) { await entry.closing; continue; }
        // A document waiting out its linger is held FOR the member who may
        // come back, never AGAINST one who is here: at the ceiling it gives up
        // its place. Each round closes at least one, so this cannot spin.
        if (entry === undefined && pages.size >= maxDocuments) {
          const freed = [...pages].flatMap(([other, resident]) =>
            evictions.has(other) ? [unload(other, resident)] : []);
          if (freed.length > 0) { await Promise.all(freed); continue; }
        }
        break;
      }

      if (stopping) throw new RoomBusy('Host stopping');
      if (entry === undefined && pages.size >= maxDocuments) throw new RoomBusy();
      if (entry !== undefined && entry.users >= maxUsers) throw new RoomBusy();

      disarm(id);
      entry ??= load(id);
      entry.users += 1;
      return entry;
    },

    release(id, entry) {
      entry.users -= 1;
      if (entry.users !== 0 || options.keepLoaded) return;
      if (linger <= 0) { void unload(id, entry); return; }
      // A room that failed to open is already gone: there is nothing to hold.
      if (pages.get(id) !== entry) return;
      disarm(id);
      const timer = setTimeout(() => {
        evictions.delete(id);
        // A member may have arrived and left again while this waited; the
        // registry it is evicting from is the one it was armed against.
        if (pages.get(id) === entry && entry.users === 0) void unload(id, entry);
      }, linger);
      // A document waiting to be evicted must never be what keeps the process up.
      timer.unref();
      evictions.set(id, timer);
      // Go arms no linger unless the room is ready (`updateEvictionLocked`). A
      // room that discarded itself serves nobody, so holding it holds its
      // journal lease against the member who is about to reconnect.
      void entry.room.then(
        (room) => {
          if (room.available?.() === false && pages.get(id) === entry && entry.users === 0) void unload(id, entry);
        },
        () => {},
      );
    },

    exclusive(id, work) {
      disarm(id);
      const pending = (transitions.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
      transitions.set(id, pending);
      return pending.finally(() => { if (transitions.get(id) === pending) transitions.delete(id); });
    },

    async retire(id, reason, loading) {
      disarm(id);
      let entry = pages.get(id);
      if (entry === undefined) {
        if (loading?.load !== true) return;
        if (pages.size >= maxDocuments) throw new RoomBusy();
        entry = load(id);
      }
      if (entry.closing !== undefined) { await entry.closing; return; }
      const retiring = entry;
      try {
        const room = await retiring.room;
        retiring.closing = Promise.resolve(room.close(reason)).then(() => {});
        await retiring.closing;
      } finally {
        forget(id, retiring);
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
