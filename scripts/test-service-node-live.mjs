/**
 * Optional live PostgreSQL conformance for apps/service-node.
 *
 * When DATABASE_URL is set, spawns `npm run dev` in apps/service-node with
 * TEST_DATABASE_URL, waits for GET /health (ephemeral http://127.0.0.1:PORT),
 * sets BLOK_SERVICE_CONFORMANCE_URL, then runs scripts/test-service-conformance.mjs
 * for harness-contract and every *-shape.json suite that declares liveOnly cases.
 *
 *   DATABASE_URL=postgres://… node scripts/test-service-node-live.mjs
 *
 * Without DATABASE_URL the runner exits 0 immediately (no server start).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allocatePort,
  startProcess,
  stopProcess,
  waitForServer,
} from './lib/server-probes.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceRoot = resolve(repositoryRoot, 'apps/service-node');
const conformanceRunner = join(repositoryRoot, 'scripts/test-service-conformance.mjs');
const fixturesDir = join(repositoryRoot, 'test/unit/service-conformance/fixtures');

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl === '') {
  console.log('service-node live: DATABASE_URL unset — skipped');
  process.exit(0);
}

function liveOnlySuites() {
  const suites = new Set(['harness-contract']);
  if (!existsSync(fixturesDir)) {
    return ['harness-contract', 'auth-contract'];
  }

  for (const file of readdirSync(fixturesDir)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const raw = readFileSync(join(fixturesDir, file), 'utf8');
    const parsed = JSON.parse(raw);
    const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
    if (!cases.some((fixtureCase) => fixtureCase.liveOnly === true)) {
      continue;
    }
    const stem = file.replace(/-shape\.json$/, '').replace(/\.json$/, '');
    suites.add(`${stem}-contract`);
  }

  return [...suites];
}

function runConformance(baseUrl, suites) {
  if (!existsSync(conformanceRunner)) {
    console.error('service-node live: scripts/test-service-conformance.mjs is missing');
    return 1;
  }

  const args = ['--target', 'node', ...suites.flatMap((suite) => ['--suite', suite])];
  console.log(`service-node live: BLOK_SERVICE_CONFORMANCE_URL=${baseUrl}`);
  console.log(`service-node live: conformance ${suites.join(', ')} (liveOnly fixture cases)`);

  const result = spawnSync(process.execPath, [conformanceRunner, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      BLOK_SERVICE_CONFORMANCE_URL: baseUrl,
    },
  });

  if (result.error !== undefined) {
    console.error(result.error.message);
    return 1;
  }
  if (result.stdout !== undefined && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr !== undefined && result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.status ?? 1;
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const port = await allocatePort();
const baseUrl = `http://127.0.0.1:${port}`;
const childEnv = {
  ...process.env,
  PORT: String(port),
  TEST_DATABASE_URL: databaseUrl,
  APPLY_SCHEMA_ON_BOOT: process.env.APPLY_SCHEMA_ON_BOOT ?? '1',
};
delete childEnv.DATABASE_URL;

const running = startProcess(npm, ['run', 'dev'], {
  cwd: serviceRoot,
  env: childEnv,
});

let exitCode = 0;

try {
  await waitForServer(running, new URL('/health', baseUrl));
  exitCode = runConformance(baseUrl, liveOnlySuites());
} catch (error) {
  console.error(
    error instanceof Error ? error.message : String(error),
    running.output(),
  );
  exitCode = 1;
} finally {
  await stopProcess(running);
}

process.exit(exitCode);