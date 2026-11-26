/**
 * The page file is the room's storage. Everything the editor shows has to make
 * the trip both ways — the first version carried only the blocks, so a page
 * opened with no title and wrote that emptiness back over its name.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { decode, encode } from '../../src/components/modules/collaboration/sync-wire';
import type { WebSocketLike } from '../../src/components/modules/collaboration/types';

import { createLocalCollab } from './local-collab';

const fileWith = (content: Record<string, unknown>) => {
  const files = { current: JSON.stringify(content), writes: 0 };

  return {
    files,
    read: () => Promise.resolve(files.current),
    write: (_id: string, data: string) => { files.current = data; files.writes++; return Promise.resolve(); },
  };
};

/**
 * Waits for the thing being asserted, not for a number of turns: the room loads
 * its file asynchronously and coalesces writes on a timer, so counting ticks
 * made this pass or fail depending on the machine.
 */
const waitUntil = async (ready: () => boolean, label: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * A peer that syncs first, then edits — the order a real editor follows.
 *
 * Editing before the room's state arrives is not "the same edit, sooner": it is
 * a concurrent write against the value loaded from the file, and a concurrent
 * write to one key is settled by client id. Doing it here made the test win or
 * lose a coin toss.
 */
const edit = (socket: WebSocketLike, change: (doc: Y.Doc) => void): void => {
  const local = new Y.Doc();
  const state = { edited: false };

  socket.onmessage = ({ data }) => {
    const frame = decode(data as Uint8Array);

    if (frame.type === 'control') {
      socket.send(encode({ type: 'syncStep1', stateVector: Y.encodeStateVector(local) }));
    }
    if (frame.type === 'syncStep1') {
      socket.send(encode({ type: 'syncStep2', update: Y.encodeStateAsUpdate(local, frame.stateVector) }));
    }
    if (frame.type === 'syncStep2' || frame.type === 'update') {
      Y.applyUpdate(local, frame.update, 'remote');

      if (frame.type === 'syncStep2' && !state.edited) {
        state.edited = true;
        change(local);
      }
    }
  };
  local.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') {
      socket.send(encode({ type: 'update', update }));
    }
  });
};

const written = (current: string): { title?: string; icon?: { value?: string }; blocks: Array<{ id?: string }> } =>
  JSON.parse(current) as { title?: string; icon?: { value?: string }; blocks: Array<{ id?: string }> };

describe('a local page as the room sees it', () => {
  it('carries a rename made in one window out to the file', async () => {
    const file = fileWith({
      title: 'Skills',
      icon: { type: 'emoji', value: '🧠' },
      blocks: [{ id: 'b1', type: 'paragraph', data: { text: 'a line of the page' } }],
    });
    const hub = createLocalCollab('workspace-a', file);

    // The shared document owns the title now; renaming it there must reach disk,
    // or the tab keeps showing a name nothing agrees with.
    edit(hub.socketFactory('ws://local/sync/page-1', []), (doc) => doc.getMap('page').set('title', 'Skills renommée'));
    // Not "a write happened": the room also writes when it first syncs, and that
    // one still carries the old name.
    await waitUntil(() => written(file.files.current).title === 'Skills renommée', 'the rename to reach the file');
    await hub.flush();

    expect(written(file.files.current).title).toBe('Skills renommée');
    expect(written(file.files.current).icon?.value).toBe('🧠');
    expect(written(file.files.current).blocks.map((block) => block.id)).toEqual(['b1']);
    hub.close();
  });

  it('falls back to the name the index holds when the file predates titles in it', async () => {
    const file = fileWith({ blocks: [{ id: 'b1', type: 'paragraph', data: { text: 'body' } }] });
    const hub = createLocalCollab('workspace-a', { ...file, title: () => 'Notes de réunion' });

    edit(hub.socketFactory('ws://local/sync/page-1', []), (doc) => doc.getMap('touch').set('n', 1));
    await waitUntil(() => written(file.files.current).title === 'Notes de réunion', 'the name to reach the file');
    await hub.flush();

    expect(written(file.files.current).title).toBe('Notes de réunion');
    hub.close();
  });
});
