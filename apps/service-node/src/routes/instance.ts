import { Hono } from 'hono';

import { loadConfig } from '@/config.js';
import type { Database } from '@/db/index.js';
import { readServiceVersion } from '@/setup/version.js';
import { countUsers } from '@/setup/user-count.js';

export interface InstanceStatus {
  ready: boolean;
  database: boolean;
  sidecar: boolean;
  mailer: boolean;
  version: string;
  userCount?: number;
}

export function readInstanceStatus(): Omit<InstanceStatus, 'userCount'> {
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
    version: readServiceVersion(),
  };
}

export interface InstanceRoutesOptions {
  database: Database | undefined;
}

export function createInstanceRoutes(options: InstanceRoutesOptions): Hono {
  const instanceRoutes = new Hono();

  instanceRoutes.get('/api/instance', async (context) => {
    const base = readInstanceStatus();
    if (options.database === undefined) {
      return context.json(base);
    }
    try {
      const userCount = await countUsers(options.database);
      return context.json({ ...base, userCount });
    } catch {
      return context.json(base);
    }
  });

  return instanceRoutes;
}