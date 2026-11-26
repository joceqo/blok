/**
 * A local workspace has no server, so its document was a file the editor
 * rewrote whole on every save. Whatever touched that file in between — a second
 * window, an agent over MCP — could only be refused, because at that point
 * there are two complete documents and no record of who changed what.
 *
 * The collaboration module takes its transport by injection, so the same editor
 * path runs against a relay that never leaves the device. These tests hold that
 * relay to what the remote one does: two peers converge, and the room survives
 * a restart.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createLocalSyncHub, type LocalRoomStorage } from '../../../src/components/modules/collaboration/local-room';
import { decode, encode } from '../../../src/components/modules/collaboration/sync-wire';
import type { WebSocketLike } from '../../../src/components/modules/collaboration/types';

const settle = async (): Promise<void> => {
  for (let round = 0; round < 12; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const memoryStorage = (): LocalRoomStorage & { files: Map<string, Uint8Array> } => {
  const files = new Map<string, Uint8Array>();

  return {
    files,
    load: (doc) => Promise.resolve(files.get(doc) ?? null),
    save: (doc, state) => {
      files.set(doc, state);

      return Promise.resolve();
    },
  };
};

/** The provider's half of the handshake, reduced to what this relay answers. */
const connect = (socketFactory: (url: string, protocols: string[]) => WebSocketLike, doc: string) => {
  const local = new Y.Doc();
  const socket = socketFactory(`ws://local/sync/${encodeURIComponent(doc)}`, []);
  const state = { control: 0, opened: false };

  socket.onopen = () => { state.opened = true; };
  socket.onmessage = ({ data }) => {
    const frame = decode(data as Uint8Array);

    if (frame.type === 'control') {
      state.control++;
      socket.send(encode({ type: 'syncStep1', stateVector: Y.encodeStateVector(local) }));
    }
    if (frame.type === 'syncStep1') {
      socket.send(encode({ type: 'syncStep2', update: Y.encodeStateAsUpdate(local, frame.stateVector) }));
    }
    if (frame.type === 'syncStep2' || frame.type === 'update') {
      Y.applyUpdate(local, frame.update, 'remote');
    }
  };
  local.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') {
      socket.send(encode({ type: 'update', update }));
    }
  });

  return { local, socket, state };
};

describe('local sync room', () => {
  it('carries an edit from one window to another, with no server in between', async () => {
    const hub = createLocalSyncHub({ saveDelayMs: 1 });
    const first = connect(hub.socketFactory, 'page-1');
    const second = connect(hub.socketFactory, 'page-1');

    await settle();
    expect(first.state.opened && second.state.opened).toBe(true);
    expect(first.state.control).toBe(1);

    first.local.getMap('blocks').set('b1', 'written in the first window');
    await settle();

    expect(second.local.getMap('blocks').get('b1')).toBe('written in the first window');
    hub.close();
  });

  it('merges two edits made at the same time instead of letting the last one win', async () => {
    const hub = createLocalSyncHub({ saveDelayMs: 1 });
    const window1 = connect(hub.socketFactory, 'page-1');
    const agent = connect(hub.socketFactory, 'page-1');

    await settle();
    window1.local.getMap('blocks').set('typed', 'what the person wrote');
    agent.local.getMap('blocks').set('added', 'what the agent wrote');
    await settle();

    for (const peer of [window1, agent]) {
      expect(peer.local.getMap('blocks').get('typed')).toBe('what the person wrote');
      expect(peer.local.getMap('blocks').get('added')).toBe('what the agent wrote');
    }
    hub.close();
  });

  it('keeps separate documents apart', async () => {
    const hub = createLocalSyncHub({ saveDelayMs: 1 });
    const notes = connect(hub.socketFactory, 'page-1');
    const skills = connect(hub.socketFactory, 'page-2');

    await settle();
    notes.local.getMap('blocks').set('b1', 'notes');
    await settle();

    expect(skills.local.getMap('blocks').get('b1')).toBeUndefined();
    hub.close();
  });

  it('restores the room from storage, so a restart opens what was written', async () => {
    const storage = memoryStorage();
    const first = createLocalSyncHub({ storage, saveDelayMs: 1 });
    const writer = connect(first.socketFactory, 'page-1');

    await settle();
    writer.local.getMap('blocks').set('b1', 'survives the restart');
    await settle();
    await first.flush();
    first.close();

    expect(storage.files.has('page-1')).toBe(true);

    const second = createLocalSyncHub({ storage, saveDelayMs: 1 });
    const reader = connect(second.socketFactory, 'page-1');

    await settle();
    expect(reader.local.getMap('blocks').get('b1')).toBe('survives the restart');
    second.close();
  });
});

/** Stands in for the desktop's window-to-window bus, frames and all. */
const createBus = () => {
  const handlers = new Set<(doc: string, frame: Uint8Array) => void>();

  return {
    linkFor: (owner: symbol) => ({
      send: (doc: string, frame: Uint8Array) => {
        // A bus never echoes to its sender, exactly like the Tauri event bridge.
        for (const handler of handlers) {
          if ((handler as { owner?: symbol }).owner !== owner) {
            handler(doc, frame);
          }
        }
      },
      subscribe: (handler: (doc: string, frame: Uint8Array) => void) => {
        Object.assign(handler, { owner });
        handlers.add(handler);

        return () => handlers.delete(handler);
      },
    }),
  };
};

describe('two processes linked by a bus', () => {
  it('converges the same page across two hubs, as two windows would', async () => {
    const bus = createBus();
    const first = createLocalSyncHub({ link: bus.linkFor(Symbol('window-1')), saveDelayMs: 1 });
    const second = createLocalSyncHub({ link: bus.linkFor(Symbol('window-2')), saveDelayMs: 1 });
    const inFirst = connect(first.socketFactory, 'page-1');
    const inSecond = connect(second.socketFactory, 'page-1');

    await settle();
    inFirst.local.getMap('blocks').set('typed', 'written in window one');
    inSecond.local.getMap('blocks').set('added', 'written in window two');
    await settle();

    for (const session of [inFirst, inSecond]) {
      expect(session.local.getMap('blocks').get('typed')).toBe('written in window one');
      expect(session.local.getMap('blocks').get('added')).toBe('written in window two');
    }
    first.close();
    second.close();
  });

  it('hands a late window what the first one already wrote', async () => {
    const bus = createBus();
    const first = createLocalSyncHub({ link: bus.linkFor(Symbol('window-1')), saveDelayMs: 1 });
    const early = connect(first.socketFactory, 'page-1');

    await settle();
    early.local.getMap('blocks').set('b1', 'written before the second window opened');
    await settle();

    const second = createLocalSyncHub({ link: bus.linkFor(Symbol('window-2')), saveDelayMs: 1 });
    const late = connect(second.socketFactory, 'page-1');

    await settle();
    expect(late.local.getMap('blocks').get('b1')).toBe('written before the second window opened');
    first.close();
    second.close();
  });
});
