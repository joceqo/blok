import type { Handler } from '../http/server.ts';
import { createRouterHandler } from './handler.ts';
import type { HostAppOptions } from './options.ts';

export type { HostAppOptions } from './options.ts';

export function createHostHandler(options: HostAppOptions): Handler {
  return createRouterHandler(options);
}