import { Hono } from 'hono';

import { loadConfig } from '../config.js';

export interface InstanceStatus {
  ready: boolean;
  database: boolean;
  sidecar: boolean;
  mailer: boolean;
}

export function readInstanceStatus(): InstanceStatus {
  const config = loadConfig();
  const database = config.databaseUrl !== undefined && config.databaseUrl !== '';
  const sidecar =
    config.blokSidecarUrl !== undefined && config.blokSidecarUrl !== '';
  const mailer = config.mailerHost !== undefined && config.mailerHost !== '';
  return {
    ready: database,
    database,
    sidecar,
    mailer,
  };
}

export const instanceRoutes = new Hono();

instanceRoutes.get('/api/instance', (context) =>
  context.json(readInstanceStatus()),
);

instanceRoutes.get('/api/setup/status', (context) =>
  context.json(readInstanceStatus()),
);