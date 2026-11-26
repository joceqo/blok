import type { Handler } from '../http/server.ts';
import { createRouterHandler } from './handler.ts';
import type { HostAppOptions } from './options.ts';
import { createSyncRooms } from './sync-room.ts';

export type { HostAppOptions } from './options.ts';

export interface HostApp {
  handler: Handler;
  /** Drains the collaboration rooms and releases their journal leases. */
  close(): Promise<void>;
}

export function createHostApp(options: HostAppOptions): HostApp {
  // Collaboration is what owns rooms. The journal decides what a room may
  // offer a member, not whether there is one to join.
  const sync = options.collabEnabled ? createSyncRooms(options) : undefined;
  return {
    handler: createRouterHandler(options, sync),
    close: async () => {
      await sync?.close();
    },
  };
}

export function createHostHandler(options: HostAppOptions): Handler {
  return createHostApp(options).handler;
}
