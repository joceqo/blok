/**
 * Cloud host checks for apps/service-node (Hono product API).
 *
 * Runs the package Vitest suite in apps/service-node. For recorded HTTP parity
 * against the Go oracle, use scripts/test-service-conformance.mjs instead
 * (docs/plans/server-node-nifty-zebra.md §2.1).
 *
 *   node scripts/test-service-node.mjs [--target node]
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceRoot = resolve(repositoryRoot, 'apps/service-node');

const TARGETS = ['node'];

function parseArgs(argv) {
  const args = [...argv];
  const targetIndex = args.indexOf('--target');
  const target = targetIndex >= 0 ? args[targetIndex + 1] : 'node';

  if (!TARGETS.includes(target)) {
    console.error(
      'Usage: node scripts/test-service-node.mjs [--target node]\n',
    );
    process.exit(1);
  }

  return { target };
}

function runVitest() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['test'], {
    cwd: serviceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  });
  if (result.error !== undefined) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.stdout !== undefined && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr !== undefined && result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.status ?? 1);
}

const options = parseArgs(process.argv.slice(2));

if (options.target === 'node') {
  console.log('service-node: npm test in apps/service-node');
  runVitest();
}