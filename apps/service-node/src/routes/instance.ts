import { Hono } from 'hono';

import { loadConfig } from '../config.ts';
import type { Database } from '../db/index.ts';
import { checkSidecarReachable } from '../sidecar/client.ts';
import { readServiceVersion } from '../setup/version.ts';
import { countUsers } from '../setup/user-count.ts';

export interface InstanceStatus {
  ready: boolean;
  database: boolean;
  sidecar: boolean;
  mailer: boolean;
  version: string;
  userCount?: number;
  /** Present when `BLOK_SIDECAR_URL` is set — result of a live `/health` probe. */
  sidecarReachable?: boolean;
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
    const status: InstanceStatus = { ...base };
    if (base.sidecar) {
      status.sidecarReachable = await checkSidecarReachable();
    }
    if (options.database === undefined) {
      return context.json(status);
    }
    try {
      const userCount = await countUsers(options.database);
      return context.json({ ...status, userCount });
    } catch {
      return context.json(status);
    }
  });

  return instanceRoutes;
}