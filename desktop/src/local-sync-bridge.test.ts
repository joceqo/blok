import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners: Array<(event: { payload: unknown }) => void> = [];
const unlisten = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.push(handler);

    return Promise.resolve(unlisten);
  },
}));

const { createDesktopRoomLink } = await import('./local-sync-bridge');

interface Bridge { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }

describe('the window end of the collaboration relay', () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];

  beforeEach(() => {
    calls.length = 0;
    listeners.length = 0;
    (window as unknown as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__ = {
      invoke: async (command, args) => { calls.push({ command, args }); return null; },
    };
  });

  it('hands a frame to the native relay, tagged with its workspace and page', () => {
    createDesktopRoomLink('workspace-a')?.send('page-1', new Uint8Array([1, 2, 3]));

    expect(calls).toEqual([{
      command: 'collab_broadcast',
      args: { workspace: 'workspace-a', doc: 'page-1', frame: [1, 2, 3] },
    }]);
  });

  it('delivers a frame from another window, and ignores another workspace', async () => {
    const received: Array<{ doc: string; bytes: number[] }> = [];
    const link = createDesktopRoomLink('workspace-a');

    link?.subscribe((doc, frame) => received.push({ doc, bytes: [...frame] }));
    await Promise.resolve();

    listeners.forEach((handler) => handler({ payload: { workspace: 'workspace-a', doc: 'page-1', frame: [7, 8] } }));
    listeners.forEach((handler) => handler({ payload: { workspace: 'workspace-b', doc: 'page-9', frame: [9] } }));

    expect(received).toEqual([{ doc: 'page-1', bytes: [7, 8] }]);
  });

  it('serves a browser tab nothing to relay, rather than a broken link', () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__;

    expect(createDesktopRoomLink('workspace-a')).toBeNull();
  });
});
