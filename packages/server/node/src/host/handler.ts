import type { Handler } from '../http/server.ts';
import { buildRouter } from './map-routes.ts';
import type { HostAppOptions } from './options.ts';
import type { SyncRooms } from './sync-room.ts';

export function createRouterHandler(options: HostAppOptions, sync?: SyncRooms): Handler {
  const router = buildRouter(options, sync);
  return async (request, response) => {
    await router.dispatch(request, response);
  };
}

/** @deprecated Use createRouterHandler from app.ts */
export function createPhase0Handler(options: HostAppOptions): Handler {
  return createRouterHandler(options);
}