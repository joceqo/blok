// Run in each package's normal working directory. The shell tests resolve assets
// against desktop/ and both packages have independent Vitest configurations.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { enableJsdomWebStorageGuard } from './jsdom-webstorage-guard.mjs';

const packages = { desktop: 'desktop', service: 'apps/service-node' };
const args = process.argv.slice(2);
const selected = Object.hasOwn(packages, args[0]) ? [packages[args.shift()]] : Object.values(packages);
const workers = Math.max(1, Math.floor(Math.min(4, availableParallelism()) / selected.length));

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
  const run = directory => vitest(directory, ['--maxWorkers', String(workers), '--exclude', '**/*.integration.test.*', ...args]);
  const codes = [];
  if (availableParallelism() === 1) {
    for (const directory of selected) codes.push(await run(directory));
  } else {
    codes.push(...await Promise.all(selected.map(run)));
  }
  process.exitCode = codes.some(code => code !== 0) ? 1 : 0;
}
