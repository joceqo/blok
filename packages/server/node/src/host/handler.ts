import type { Handler } from '../http/server.ts';
import { buildRouter } from './map-routes.ts';
import type { HostAppOptions } from './options.ts';

export function createRouterHandler(options: HostAppOptions): Handler {
  const router = buildRouter(options);
  return async (request, response) => {
    await router.dispatch(request, response);
  };
}

/** @deprecated Use createRouterHandler from app.ts */
export function createPhase0Handler(options: HostAppOptions): Handler {
  return createRouterHandler(options);
}