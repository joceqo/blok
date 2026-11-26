import { listen } from '@tauri-apps/api/event';

import type { RoomLink } from '../../src/components/modules/collaboration/local-room';

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
}

interface CollabFramePayload {
  workspace: string;
  doc: string;
  frame: number[];
}

/**
 * Carries collaboration frames between the windows of this app.
 *
 * Each desktop window is its own webview with its own JavaScript context, so a
 * room held in one of them is invisible to the next. The native side relays the
 * frames; this is the window's end of that relay. Frames are tagged with the
 * workspace so two open workspaces never pour into each other.
 *
 * Returns null outside Tauri — a browser tab has no sibling windows to reach,
 * and its hub serves itself.
 */
export const createDesktopRoomLink = (workspace: string): RoomLink | null => {
  const bridge = (window as TauriWindow).__TAURI_INTERNALS__;

  if (bridge === undefined) {
    return null;
  }

  return {
    send(doc, frame) {
      // Fire and forget: a dropped frame costs a round of catch-up, never the edit.
      void bridge.invoke('collab_broadcast', { workspace, doc, frame: Array.from(frame) })
        .catch(() => undefined);
    },
    subscribe(handler) {
      const state = { stop: null as (() => void) | null, cancelled: false };

      void listen<CollabFramePayload>('blok:collab-frame', (event) => {
        if (event.payload.workspace === workspace) {
          handler(event.payload.doc, new Uint8Array(event.payload.frame));
        }
      }).then((unlisten) => {
        if (state.cancelled) {
          unlisten();

          return;
        }
        state.stop = unlisten;
      }).catch(() => undefined);

      return () => {
        state.cancelled = true;
        state.stop?.();
        state.stop = null;
      };
    },
  };
};
