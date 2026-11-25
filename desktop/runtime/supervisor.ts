import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { gateway } from './gateway.ts';
import { checkPrivatePorts, choosePorts, listen, loopback, openInstance } from './instance.ts';

const { values } = parseArgs({ options: { resources: { type: 'string' }, data: { type: 'string' }, web: { type: 'string' } } });
if (!values.resources || !values.data || !values.web) throw new Error('Expected --resources <directory> --data <directory> --web <directory>');
const resources = resolve(values.resources);
const data = resolve(values.data);
const web = resolve(values.web);
const exe = process.platform === 'win32' ? '.exe' : '';
const binary = (name: string) => join(resources, 'bin', name + exe);
const pg = (name: string) => join(resources, 'postgres', 'bin', name + exe);
const postgresDirectory = join(data, 'postgres');
const stopped = new AbortController();
let failure: Error | undefined;
function stop(error?: Error) {
  if (!stopped.signal.aborted) {
    failure = error;
    stopped.abort();
  }
}
process.stdin.once('end', () => stop()).once('error', () => stop()).resume();
process.once('SIGTERM', () => stop());
process.once('SIGINT', () => stop());
if (process.platform !== 'win32') process.umask(0o077);

type Service = { label: string; child: ChildProcess; done: Promise<void> };
const services: Service[] = [];
let logFd: number;
const baseEnv: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'TMP', 'TEMP', 'TMPDIR', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) {
  if (process.env[key]) baseEnv[key] = process.env[key];
}
function start(label: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}, failed: (error: Error) => void = stop) {
  stopped.signal.throwIfAborted();
  const child = spawn(command, args, { cwd: data, env: { ...baseEnv, ...env }, windowsHide: true, stdio: ['ignore', logFd, logFd] });
  const done = new Promise<void>(resolve => {
    child.once('error', error => { if (!stopped.signal.aborted) failed(new Error(label + ': ' + error.message)); resolve(); });
    child.once('exit', (code, signal) => { if (!stopped.signal.aborted) failed(new Error(label + ' exited (' + (code ?? signal) + '). See runtime.log')); resolve(); });
  });
  services.push({ label, child, done });
  return child;
}
async function command(command: string, args: string[], capture = false, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: data, env: baseEnv, windowsHide: true, signal,
      stdio: ['ignore', capture ? 'pipe' : logFd, logFd] });
    let output = '';
    if (capture) child.stdout!.on('data', chunk => { output += chunk; });
    let failure: Error | undefined;
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      if (failure) reject(failure);
      else if (code === 0) resolve(output.trim());
      else reject(new Error(command + ' exited (' + code + '). See runtime.log'));
    });
  });
}
async function until(label: string, check: () => Promise<boolean>, signal = stopped.signal) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await check().catch(() => false)) return;
    await delay(50, undefined, { signal });
  }
  throw new Error(label + ' did not become ready. See runtime.log');
}
function healthy(origin: string, path: string, signal = stopped.signal) {
  return async () => {
    // Each probe is one-shot. A pooled socket otherwise keeps the media server
    // waiting for another request during an early quit.
    const response = await fetch(origin + path, { headers: { connection: 'close' }, signal: AbortSignal.any([signal, AbortSignal.timeout(1_500)]) });
    await response.body?.cancel();
    return response.ok;
  };
}
async function setupDatabase(password: string) {
  const reported = await command(pg('postgres'), ['--version'], true, stopped.signal);
  const major = reported.match(/PostgreSQL\)?\s+(\d+)/)?.[1];
  if (!major) throw new Error('Cannot identify bundled PostgreSQL version');
  // An existing incomplete or incompatible cluster must never be replaced.
  if (await stat(postgresDirectory).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) {
    const version = (await readFile(join(postgresDirectory, 'PG_VERSION'), 'utf8')).trim();
    if (version !== major) throw new Error('Local database uses PostgreSQL ' + version + '. Migration to ' + major + ' is required');
    return;
  }
  const pending = await mkdtemp(join(data, '.initdb-'));
  const pwfile = join(data, '.pg-password-' + randomUUID());
  try {
    await writeFile(pwfile, password + '\n', { flag: 'wx', mode: 0o600 });
    await command(pg('initdb'), ['-D', pending, '--encoding=UTF8', '--no-locale', '--username=blok', '--auth=scram-sha-256', '--pwfile=' + pwfile], false, stopped.signal);
    await rename(pending, postgresDirectory);
  } finally {
    await Promise.all([rm(pwfile, { force: true }), rm(pending, { recursive: true, force: true })]);
  }
}
async function shutdown(service: Service) {
  const { child, done, label } = service;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (label === 'PostgreSQL' && process.platform === 'win32') {
    await command(pg('pg_ctl'), ['stop', '-D', postgresDirectory, '-m', 'fast', '-t', '5']).catch(() => child.kill());
  } else child.kill(label === 'PostgreSQL' ? 'SIGINT' : 'SIGTERM');
  const finished = await Promise.race([done.then(() => true), delay(label === 'Room' ? 12_000 : 4_000, false, { ref: false })]);
  if (!finished) { child.kill('SIGKILL'); await done; }
}

await mkdir(data, { recursive: true, mode: 0o700 });
const { ports, secrets } = await openInstance(data);
const origin = (port: number) => 'http://' + loopback + ':' + port;
const publicOrigin = origin(ports.public);
const api = origin(ports.api);
const deviceSecret = randomBytes(32).toString('hex');
const room = origin(ports.room);
const media = origin(ports.media);
const s3 = origin(ports.s3);
const front = gateway(ports, web);
try {
  // Keep this public socket reserved through teardown to serialize launches on the same data.
  await listen(front.server, ports.public);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error('Local Blok port ' + ports.public + ' is already in use');
  throw error;
}
const log = await open(join(data, 'runtime.log'), 'w', 0o600);
logFd = log.fd;
const storage = { BLOK_S3_BUCKET: 'blok-assets', BLOK_S3_ENDPOINT: s3, BLOK_S3_REGION: 'us-east-1',
  BLOK_S3_ADDRESSING: 'path', BLOK_S3_ACCESS_KEY: secrets.accessKey, BLOK_S3_SECRET_KEY: secrets.secretKey };
const allowedOrigins = 'tauri://localhost,http://tauri.localhost,https://tauri.localhost';
const storageStopped = new AbortController();
const storageSignal = storageStopped.signal;
function storageFailure(error: Error) {
  if (storageSignal.aborted) return;
  storageStopped.abort();
  front.setStorage('failed');
  void log.write('Storage unavailable: ' + error.message + '\n').catch(() => {});
}
async function startStorage() {
  await checkPrivatePorts(ports, 'storage');
  start('Media', binary('node'), [join(resources, 'room', 'media.mjs'), '--listen', loopback + ':' + ports.media, '--auth', 'ticket',
    '--public-url', publicOrigin + '/files', '--allow-origin', publicOrigin, '--storage-dir', join(data, 'uploads'), '--rate-limit', '600'],
    { ...storage, BLOK_SECRET: secrets.ticket }, storageFailure);
  const objects = join(data, 'objects');
  await mkdir(objects, { recursive: true });
  const admin = await choosePorts(['http', 'grpc'] as const, Object.values(ports));
  start('SeaweedFS', binary('weed'), ['mini', '-dir=' + objects, '-ip=' + loopback, '-ip.bind=' + loopback,
    // The single local volume has no other nodes waiting on routing heartbeats.
    '-volume.preStopSeconds=0', '-master.telemetry=false', '-webdav=false', '-admin.ui=false', '-admin.port.legacy=0', '-s3.port.iceberg=0', '-s3.port.lance=0',
    '-admin.port=' + admin.http, '-admin.port.grpc=' + admin.grpc,
    '-master.port=' + ports.master, '-master.port.grpc=' + ports.masterGrpc, '-volume.port=' + ports.volume,
    '-volume.port.grpc=' + ports.volumeGrpc, '-filer.port=' + ports.filer, '-filer.port.grpc=' + ports.filerGrpc,
    '-s3.port=' + ports.s3, '-s3.port.grpc=' + ports.s3Grpc, '-filer.allowedOrigins=' + publicOrigin, '-s3.allowedOrigins=' + publicOrigin],
    { AWS_ACCESS_KEY_ID: secrets.accessKey, AWS_SECRET_ACCESS_KEY: secrets.secretKey, S3_BUCKET: 'blok-assets',
      WEED_ADMIN_PASSWORD: createHmac('sha256', secrets.internal).update('seaweed-admin').digest('hex') }, storageFailure);
  await Promise.all([
    until('SeaweedFS', healthy(s3, '/readyz', storageSignal), storageSignal),
    until('Media', healthy(media, '/health', storageSignal), storageSignal),
  ]);
  if (!storageSignal.aborted) front.setStorage('ready');
}
let storageStartup: Promise<void> | undefined;
try {
  await Promise.all([checkPrivatePorts(ports, 'editor'), access(join(web, 'index.html'))]);
  storageStartup = startStorage().catch(storageFailure);
  start('Room', binary('node'), [join(resources, 'room', 'room.mjs'), join(data, 'collab'), '--all', publicOrigin, String(ports.room)],
    { BLOK_ROOM_LISTEN_HOST: loopback, BLOK_ROOM_CLOUD_ORIGIN: api, BLOK_ROOM_PROJECTION_ORIGIN: api, INTERNAL_SECRET: secrets.internal,
      ALLOWED_ORIGINS: allowedOrigins, BLOK_FLOCK_HELPER: binary('blok-flock') });
  await setupDatabase(secrets.postgres);
  const postgres = start('PostgreSQL', pg('postgres'), ['-D', postgresDirectory, '-h', loopback, '-p', String(ports.postgres), '-c', 'unix_socket_directories=']);
  await until('PostgreSQL', async () => {
    const status = await readFile(join(postgresDirectory, 'postmaster.pid'), 'utf8');
    return status.split('\n')[0] === String(postgres.pid) && status.split('\n')[7]?.trim() === 'ready';
  });
  const databaseUrl = 'postgresql://blok:' + secrets.postgres + '@' + loopback + ':' + ports.postgres + '/postgres';
  start('Shell', binary('node'), [join(resources, 'app', 'main.mjs')], { ...storage, DATABASE_URL: databaseUrl,
    PUBLIC_URL: publicOrigin, PORT: String(ports.api), BLOK_LISTEN_HOST: loopback, BLOK_NODE_ROOM_ALL: '1',
    DATA_DIRECTORY: data, BLOK_SCHEMA_PATH: join(resources, 'app', 'schema.sql'), ALLOWED_ORIGINS: allowedOrigins,
    BLOK_DEVICE_SESSION_SECRET: deviceSecret, INTERNAL_SECRET: secrets.internal, TICKET_SECRET: secrets.ticket, BLOK_MEDIA_ORIGIN: media, BLOK_ROOM_STATE_ORIGIN: room,
    MCP_SYNC_URL: room.replace('http:', 'ws:') + '/api/blok/sync', BLOK_DEVELOPMENT: '1' });
  await until('Shell', healthy(api, '/healthz'));
  if (basename(data) === 'embedded-server') {
    const {migrateLegacyWorkspace} = await import(pathToFileURL(join(resources, 'app', 'import-disk.mjs')).href);
    const imported = await migrateLegacyWorkspace(join(dirname(data), 'workspace'), databaseUrl);
    if (imported) await log.write('Migration du dossier local : ' + JSON.stringify(imported) + '\n');
  }
  await until('Room', healthy(room, '/healthz'));
  stopped.signal.throwIfAborted();
  front.setReady();
  process.stdout.write(JSON.stringify({ origin: publicOrigin, apiOrigin: api, deviceSecret }) + '\n');
  await new Promise<void>(resolve => stopped.signal.addEventListener('abort', () => resolve(), { once: true }));
} catch (error) {
  if (!stopped.signal.aborted) stop(error instanceof Error ? error : new Error(String(error)));
} finally {
  await front.stopAccepting();
  storageStopped.abort();
  await storageStartup;
  // The journal flushes its final projection through the shell; outstanding shell
  // uploads can in turn still require media. Keep each dependency alive until then.
  for (const label of ['Room', 'Shell', 'Media']) {
    const service = services.find(s => s.label === label);
    if (service) await shutdown(service);
  }
  await Promise.all(services.filter(s => s.label === 'PostgreSQL' || s.label === 'SeaweedFS').map(shutdown));
  await new Promise<void>(resolve => front.server.close(() => resolve()));
  await log.close();
  process.stdin.destroy();
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
