import * as Y from 'yjs';

import { decode, encode } from './sync-wire';
import type { CollabSocketFactory, SyncWireFrame, WebSocketLike } from './types';

/**
 * Where a room's document lives between sessions. A host that keeps nothing
 * passes none, and the room is memory-only — useful in a test, and the shape a
 * browser tier uses before it has somewhere to write.
 */
export interface LocalRoomStorage {
  load(doc: string): Promise<Uint8Array | null>;
  save(doc: string, state: Uint8Array): Promise<void>;
}

/**
 * Carries frames between the hubs of separate processes — the windows of a
 * desktop app, each with its own JavaScript context. Yjs updates commute, so
 * hubs linked this way converge without one of them being the authority.
 */
export interface RoomLink {
  send(doc: string, frame: Uint8Array): void;
  subscribe(handler: (doc: string, frame: Uint8Array) => void): () => void;
}

export interface LocalSyncHubOptions {
  storage?: LocalRoomStorage;
  /** Absent, the hub serves this process alone. */
  link?: RoomLink;
  /**
   * Announced in every control frame. A client compares it by equality and
   * drops its cache when it changes, so one host must keep one value.
   */
  lineage?: string;
  /** Mirrors the server's message cap; clients refuse an oversized frame against it. */
  maxMessageBytes?: number;
  /** How long writes are coalesced before the state reaches storage. */
  saveDelayMs?: number;
}

export interface LocalSyncHub {
  /** Hand this to `collaboration.socketFactory`; `server` only names the room. */
  socketFactory: CollabSocketFactory;
  /** Resolves once every pending write has reached storage. */
  flush(): Promise<void>;
  close(): void;
}

const DEFAULT_LINEAGE = '00000000000000000000000000000000';
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_SAVE_DELAY_MS = 50;

/** Marks what the relay itself applied, so a host can tell it from a peer's edit. */
const LOCAL_ORIGIN = { source: 'blok-local-room' };

/** Marks what arrived from another process, so it is never sent straight back. */
const PEER_ORIGIN = { source: 'blok-local-room-peer' };

/** The document id is the last segment of the sync URL the provider built. */
const docIdFrom = (url: string): string => {
  const path = url.split('?')[0] ?? url;
  const segment = path.slice(path.lastIndexOf('/') + 1);

  return decodeURIComponent(segment);
};

/** Y.applyUpdate takes the bytes verbatim; a view over a larger buffer would carry its neighbours. */
const bytesOf = (data: ArrayBufferLike | ArrayBufferView): Uint8Array => (
  ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    : new Uint8Array(data as ArrayBuffer)
);

/** What a room needs of a connected socket — declared here so Room stays resolvable. */
interface RoomMember {
  deliver(frame: SyncWireFrame): void;
  close(code?: number, reason?: string): void;
}

interface Room {
  doc: Y.Doc;
  ready: Promise<void>;
  members: Set<RoomMember>;
  save: { timer: ReturnType<typeof setTimeout> | null; inFlight: Promise<void> };
}

/**
 * A sync service that never leaves the device.
 *
 * The collaboration module already takes its transport by injection, so a room
 * that relays frames between the sockets it hands out is the whole difference
 * between "this workspace is on a server" and "this workspace is a folder". It
 * lets a local workspace run the same editor path as a remote one: a document
 * nobody rewrites whole, edited by several windows and by an agent at once,
 * instead of a file whose last writer wins and whose guard can only refuse.
 *
 * It speaks v1 of the wire protocol: sync, awareness, and the control and limit
 * announcements a client waits for before it lifts its read-only veto. Durable
 * acknowledgement (`blok-sync-v2.md` sections 7 and 8) is not implemented, so a
 * host must not report an edit as saved on the strength of a relay alone.
 */
export const createLocalSyncHub = (options: LocalSyncHubOptions = {}): LocalSyncHub => {
  const lineage = options.lineage ?? DEFAULT_LINEAGE;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
  const rooms = new Map<string, Room>();
  const hub = { closed: false };
  const sendToPeers = (doc: string, frame: SyncWireFrame): void => {
    options.link?.send(doc, encode(frame));
  };

  const roomFor = (id: string): Room => {
    const existing = rooms.get(id);

    if (existing !== undefined) {
      return existing;
    }

    const doc = new Y.Doc();
    const room: Room = {
      doc,
      members: new Set(),
      save: { timer: null, inFlight: Promise.resolve() },
      ready: (async () => {
        const stored = await options.storage?.load(id) ?? null;

        // An empty update is not a document: applying one throws.
        if (stored !== null && stored.length > 0) {
          Y.applyUpdate(doc, stored, LOCAL_ORIGIN);
        }
        // Peers answer with what this process has not seen yet.
        sendToPeers(id, { type: 'syncStep1', stateVector: Y.encodeStateVector(doc) });
      })(),
    };

    rooms.set(id, room);

    return room;
  };

  const persist = (id: string): void => {
    const room = rooms.get(id);

    if (options.storage === undefined || room === undefined || room.save.timer !== null) {
      return;
    }

    room.save.timer = setTimeout(() => {
      room.save.timer = null;
      room.save.inFlight = room.save.inFlight
        .catch(() => undefined)
        .then(() => options.storage?.save(id, Y.encodeStateAsUpdate(room.doc)));
      void room.save.inFlight.catch(() => undefined);
    }, saveDelayMs);
  };

  class LocalSocket implements WebSocketLike {
    public binaryType = 'arraybuffer';
    public readyState = 0;
    public readonly protocol = '';
    public onopen: ((event: unknown) => void) | null = null;
    public onmessage: ((event: { data: unknown }) => void) | null = null;
    public onclose: ((event: { code: number; reason: string }) => void) | null = null;
    public onerror: ((event: unknown) => void) | null = null;

    private readonly id: string;
    private readonly room: Room;

    public constructor(url: string) {
      this.id = docIdFrom(url);
      this.room = roomFor(this.id);

      void this.room.ready.then(() => {
        if (this.readyState !== 0 || hub.closed) {
          return;
        }
        this.readyState = 1;
        this.room.members.add(this);
        this.onopen?.({});
        // The client lifts its read-only veto on the control frame, so it leads.
        this.deliver({ type: 'control', tag: { format: 2, epoch: 0, lineage } });
        this.deliver({ type: 'limits', maxMessageBytes });
        this.deliver({ type: 'syncStep1', stateVector: Y.encodeStateVector(this.room.doc) });
      });
    }

    public send(data: ArrayBufferLike | ArrayBufferView): void {
      if (this.readyState !== 1) {
        return;
      }

      const frame = decode(bytesOf(data));

      if (frame.type === 'syncStep1') {
        this.deliver({ type: 'syncStep2', update: Y.encodeStateAsUpdate(this.room.doc, frame.stateVector) });
      } else if (frame.type === 'syncStep2' || frame.type === 'update') {
        this.absorb(frame.update);
      } else if (frame.type === 'awareness') {
        // Presence is relayed verbatim and never persisted: it dies with its session.
        this.broadcast({ type: 'awareness', update: frame.update });
        sendToPeers(this.id, { type: 'awareness', update: frame.update });
      } else if (frame.type === 'queryAwareness') {
        this.broadcast({ type: 'queryAwareness' });
      }
      // Anything else — malformed, or a v2 frame this relay does not speak — is
      // dropped, the way the server drops what it cannot act on.
    }

    public close(code = 1000, reason = ''): void {
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      this.room.members.delete(this);
      this.onclose?.({ code, reason });
    }

    /** Applying an update twice is harmless; relaying it to its own author is not. */
    private absorb(update: Uint8Array): void {
      Y.applyUpdate(this.room.doc, update, LOCAL_ORIGIN);
      persist(this.id);
      this.broadcast({ type: 'update', update });
      sendToPeers(this.id, { type: 'update', update });
    }

    private broadcast(frame: SyncWireFrame): void {
      for (const member of this.room.members) {
        if (member !== this) {
          member.deliver(frame);
        }
      }
    }

    /** Asynchronous on purpose: a handler must never run inside the caller's `send`. */
    public deliver(frame: SyncWireFrame): void {
      const bytes = encode(frame);

      queueMicrotask(() => {
        if (this.readyState === 1) {
          this.onmessage?.({ data: bytes });
        }
      });
    }
  }

  /** A frame from another process, handled as a peer's half of the protocol. */
  const receiveFromPeer = (id: string, bytes: Uint8Array): void => {
    if (hub.closed) {
      return;
    }

    const room = roomFor(id);

    void room.ready.then(() => {
      const frame = decode(bytes);

      if (frame.type === 'syncStep1') {
        sendToPeers(id, { type: 'syncStep2', update: Y.encodeStateAsUpdate(room.doc, frame.stateVector) });
      } else if (frame.type === 'syncStep2' || frame.type === 'update') {
        Y.applyUpdate(room.doc, frame.update, PEER_ORIGIN);
        persist(id);
        // Local sessions learn of it exactly as they would from a server.
        for (const member of room.members) {
          member.deliver({ type: 'update', update: frame.update });
        }
      } else if (frame.type === 'awareness') {
        for (const member of room.members) {
          member.deliver({ type: 'awareness', update: frame.update });
        }
      }
    });
  };

  const unsubscribe = options.link?.subscribe(receiveFromPeer);

  return {
    socketFactory: (url) => new LocalSocket(url),
    async flush() {
      for (const [id, room] of rooms) {
        if (room.save.timer !== null) {
          clearTimeout(room.save.timer);
          room.save.timer = null;
          room.save.inFlight = room.save.inFlight
            .catch(() => undefined)
            .then(() => options.storage?.save(id, Y.encodeStateAsUpdate(room.doc)));
        }
        await room.save.inFlight;
      }
    },
    close() {
      hub.closed = true;
      unsubscribe?.();
      for (const room of rooms.values()) {
        if (room.save.timer !== null) {
          clearTimeout(room.save.timer);
          room.save.timer = null;
        }
        for (const member of [...room.members]) {
          member.close(1001, 'hub closed');
        }
        room.doc.destroy();
      }
      rooms.clear();
    },
  };
};
