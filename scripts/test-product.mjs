// Run in each package's normal working directory. The shell tests resolve assets
// against desktop/ and each package has its own Vitest configuration.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { enableJsdomWebStorageGuard } from './jsdom-webstorage-guard.mjs';

const packages = { desktop: 'desktop', service: 'apps/service-node', room: 'packages/server/node' };
const args = process.argv.slice(2);
const selected = Object.hasOwn(packages, args[0]) ? [packages[args.shift()]] : Object.values(packages);
const budget = Math.min(4, availableParallelism());
const parallel = Math.min(budget, selected.length);

function vitest(directory, args) {
  const cwd = fileURLToPath(new URL(`../${directory}/`, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...args], { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

enableJsdomWebStorageGuard();

if (args.some(arg => /^(?:\.\/)?test\/unit(?:\/|$)/.test(arg.replaceAll('\\', '/')))) {
  // Preserve explicit root filters such as "yarn test test/unit/tools/code".
  process.exitCode = await vitest('.', ['--project=unit', '--project=unit-angular', ...args]);
} else {
  // Give spare workers to the first package (the DOM-heavy desktop suite).
  const run = (directory, index) => {
    const workers = Math.floor(budget / parallel) + Number(index < budget % parallel);
    // Separate the compiler caches too: the packages may use different Vitest versions.
    const cache = fileURLToPath(new URL(`../${directory}/node_modules/.vitest-cache/`, import.meta.url));
    return vitest(directory, ['--fsModuleCachePath', cache, '--maxWorkers', String(workers), '--exclude', '**/*.integration.test.*', ...args]);
  };
  const codes = [];
  for (let start = 0; start < selected.length; start += parallel) {
    codes.push(...await Promise.all(selected.slice(start, start + parallel).map(run)));
  }
  process.exitCode = codes.some(code => code !== 0) ? 1 : 0;
}
