import { createApp } from '../../../apps/service-node/src/app.ts';

import type { Hono } from 'hono';

export function createServiceAppWithoutDb(): Hono {
  return createApp({ database: undefined });
}