import { Hono } from 'hono';

import { readServiceVersion } from '../setup/version.ts';

export const healthRoutes = new Hono();

healthRoutes.get('/health', (context) => {
  return context.json({ status: 'ok', version: readServiceVersion() });
});