/**
 * The same editor path a remote workspace runs, pointed at a relay that never
 * leaves the device: a real Core boots in collaboration mode with no server
 * reachable, lifts its read-only veto on the relay's control frame, and sees
 * what the other session writes.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Core } from '../../../src/components/core';
import { createLocalSyncHub, type LocalSyncHub } from '../../../src/components/modules/collaboration/local-room';
import { Bookmark } from '../../../src/tools/link/bookmark';
import { Paragraph } from '../../../src/tools/paragraph';

const holders: HTMLElement[] = [];
const booted: Core[] = [];
const hubs: LocalSyncHub[] = [];

afterEach(() => {
  hubs.splice(0).forEach((hub) => hub.close());
  booted.splice(0).forEach((core) => {
    Object.values(core.moduleInstances).forEach((moduleInstance) => {
      (moduleInstance as { markDestroyed?: () => void } | null)?.markDestroyed?.();
    });
    Object.values(core.moduleInstances).forEach((moduleInstance) => {
      (moduleInstance as { destroy?: () => void } | null)?.destroy?.();
    });
  });
  holders.splice(0).forEach((holder) => holder.remove());
});

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 10000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const bootEditor = async (hub: LocalSyncHub, doc: string, name: string): Promise<Core> => {
  const holder = document.createElement('div');

  document.body.appendChild(holder);
  holders.push(holder);

  const core = new Core({
    holder,
    minHeight: 50,
    tools: { bookmark: { class: Bookmark }, paragraph: { class: Paragraph } },
    // No `server` at all: the relay is the transport, and a URL would only hand
    // the editor an uploader and link endpoints pointing at a host that is not there.
    collaboration: { doc, socketFactory: hub.socketFactory },
  });

  await core.isReady;
  booted.push(core);
  await waitFor(() => !core.moduleInstances.ReadOnly.isEnabled, `${name} to become writable`);

  return core;
};

describe('a local workspace on the collaboration path', () => {
  it('boots a real editor with no server, and carries an edit between two sessions', async () => {
    const hub = createLocalSyncHub({ saveDelayMs: 1 });

    hubs.push(hub);

    const first = await bootEditor(hub, 'page-1', 'the first window');
    const second = await bootEditor(hub, 'page-1', 'the second window');

    first.moduleInstances.YjsManager.addBlock({
      id: 'b1',
      type: 'paragraph',
      data: { text: 'written in the first window' },
    });

    await waitFor(
      () => second.moduleInstances.YjsManager.toJSON().some((block) => block.id === 'b1'),
      'the second window to receive the block'
    );

    const received = second.moduleInstances.YjsManager.toJSON().find((block) => block.id === 'b1');

    expect((received?.data as { text?: string } | undefined)?.text).toBe('written in the first window');
  }, 30000);

  it('merges a block written on each side instead of refusing the second one', async () => {
    const hub = createLocalSyncHub({ saveDelayMs: 1 });

    hubs.push(hub);

    const person = await bootEditor(hub, 'page-1', 'the person');
    const agent = await bootEditor(hub, 'page-1', 'the agent');

    person.moduleInstances.YjsManager.addBlock({ id: 'typed', type: 'paragraph', data: { text: 'what the person wrote' } });
    agent.moduleInstances.YjsManager.addBlock({ id: 'added', type: 'paragraph', data: { text: 'what the agent wrote' } });

    for (const [core, label] of [[person, 'the person'], [agent, 'the agent']] as const) {
      await waitFor(
        () => ['typed', 'added'].every((id) => core.moduleInstances.YjsManager.toJSON().some((block) => block.id === id)),
        `${label} to hold both blocks`
      );
    }

    expect(person.moduleInstances.YjsManager.orderedIds()).toEqual(agent.moduleInstances.YjsManager.orderedIds());
  }, 30000);
});
