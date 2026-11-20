import type { Handler } from '../http/server.ts';
import { createPhase0Handler } from './handler.ts';
import type { HostAppOptions } from './options.ts';

export type { HostAppOptions } from './options.ts';

export function createHostHandler(options: HostAppOptions): Handler {
  return createPhase0Handler(options);
}