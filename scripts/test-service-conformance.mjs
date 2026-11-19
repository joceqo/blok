/**
 * Black-box product API conformance: HTTP suites against apps/service-node,
 * with Go as the future oracle and recorded fixtures (plan §2.1).
 *
 *   node scripts/test-service-conformance.mjs [--target node|go] [--suite NAME]...
 *
 * Today only --target node runs Vitest suites under test/unit/service-conformance/.
 * Go is refused until the oracle harness and fixtures exist.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = ['node', 'go'];

const SUITES = [
  'harness-contract',
  'api-contract',
  'auth-contract',
  'workspaces-contract',
];

function parseArgs(argv) {
  const args = [...argv];
  const targetIndex = args.indexOf('--target');
  const target = targetIndex >= 0 ? args[targetIndex + 1] : 'node';
  const suites = args.flatMap((arg, index) => (arg === '--suite' ? [args[index + 1]] : []));

  const usage =
    'Usage: node scripts/test-service-conformance.mjs [--target node|go] [--suite NAME]...';

  if (
    !TARGETS.includes(target) ||
    suites.some((suite) => !SUITES.includes(suite))
  ) {
    console.error(`${usage}\n`);
    process.exit(1);
  }

  return { target, suites: suites.length > 0 ? suites : SUITES };
}

function announce(options) {
  const all = options.suites.length === SUITES.length;
  console.log(`Service conformance suites: ${all ? 'all' : options.suites.join(', ')}.`);
}

function runVitest(options) {
  const vitestArgs = [
    join(repositoryRoot, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--project=unit',
    ...options.suites.map((suite) => `test/unit/service-conformance/${suite}.test.ts`),
  ];

  const serviceUrl = process.env.BLOK_SERVICE_CONFORMANCE_URL ?? '';

  console.log(
    serviceUrl === ''
      ? 'service conformance: BLOK_SERVICE_CONFORMANCE_URL unset — HTTP suites skip'
      : `service conformance: BLOK_SERVICE_CONFORMANCE_URL=${serviceUrl}`,
  );

  const result = spawnSync(process.execPath, vitestArgs, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      BLOK_SERVICE_CONFORMANCE_URL: serviceUrl,
    },
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

function refuseGoOracle() {
  console.error(
    'The Go service target is not wired yet — Go is the oracle; recorded HTTP fixtures are pending.',
  );
  process.exit(1);
}

function runNodeTarget(options) {
  console.log('service conformance: vitest in test/unit/service-conformance');
  runVitest(options);
}

const options = parseArgs(process.argv.slice(2));
announce(options);

if (options.target === 'go') {
  refuseGoOracle();
}

runNodeTarget(options);