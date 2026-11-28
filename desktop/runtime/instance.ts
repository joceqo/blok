import { randomBytes, randomUUID } from 'node:crypto';
import { link, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

export const loopback = '127.0.0.1';
const portNames = ['public', 'api', 'media', 'room', 'postgres', 'master', 'masterGrpc', 'volume',
  'volumeGrpc', 'filer', 'filerGrpc', 's3', 's3Grpc'] as const;
type Ports = Record<typeof portNames[number], number>;
const secretNames = ['postgres', 'ticket', 'internal', 'accessKey', 'secretKey'] as const;
type Secrets = Record<typeof secretNames[number], string>;
export interface Instance { version: 1; ports: Ports; secrets: Secrets }

export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, loopback, () => {
      server.removeListener('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

export async function choosePorts<T extends string>(names: readonly T[], excluded: number[] = []): Promise<Record<T, number>> {
  const reservations: Server[] = [];
  const ports = {} as Record<T, number>;
  try {
    for (const name of names) {
      do {
        const server = createServer();
        reservations.push(server);
        ports[name] = await listen(server, 0);
      } while (excluded.includes(ports[name]));
    }
    return ports;
  } finally {
    await Promise.all(reservations.filter(s => s.listening).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  }
}

export async function checkPrivatePorts(ports: Ports, group: 'editor' | 'storage') {
  // A persisted port may now belong to another local program. Fail before passing
  // credentials to any service or letting its health endpoint satisfy readiness.
  for (const name of portNames) {
    const editor = name === 'api' || name === 'postgres' || name === 'room';
    if (name === 'public' || editor !== (group === 'editor')) continue;
    const probe = createServer();
    try {
      await listen(probe, ports[name]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error('Local ' + name + ' port ' + ports[name] + ' is already in use');
      throw error;
    } finally {
      if (probe.listening) await new Promise<void>(resolve => probe.close(() => resolve()));
    }
  }
}

export async function openInstance(directory: string): Promise<Instance> {
  const path = join(directory, 'instance.json');
  try {
    const state: Instance = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1 || !portNames.every(name => Number.isInteger(state.ports?.[name]) &&
      state.ports[name] > 0 && state.ports[name] <= 65535) || new Set(Object.values(state.ports)).size !== portNames.length ||
      !secretNames.every(name => typeof state.secrets?.[name] === 'string' && /^[a-f0-9]{48}$/.test(state.secrets[name]))) {
      throw new Error('Invalid or unsupported desktop instance configuration');
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const clusterExists = await stat(join(directory, 'postgres')).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (clusterExists) throw new Error('Missing instance.json for the local database. Restore the original instance configuration');
  const state: Instance = { version: 1, ports: await choosePorts(portNames),
    secrets: Object.fromEntries(secretNames.map(name => [name, randomBytes(24).toString('hex')])) as Secrets };
  const temporary = join(directory, '.instance-' + randomUUID());
  await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx', flush: true });
  try {
    // Never expose a partial file or replace a concurrent launcher's credentials.
    await link(temporary, path);
    if (process.platform !== 'win32') {
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await openInstance(directory);
  } finally {
    await unlink(temporary);
  }
}
