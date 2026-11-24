import { chmod, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodePackage = join(repositoryRoot, 'packages/server/node');
const outDir = join(nodePackage, 'dist');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function bundle(outfile, conformance, entry = 'src/main.ts') {
  const define = conformance ? '--define:BLOK_CONFORMANCE=true' : '--define:BLOK_CONFORMANCE=false';
  await run(
    process.execPath,
    [
      join(repositoryRoot, 'node_modules/esbuild/bin/esbuild'),
      join(nodePackage, entry),
      '--bundle',
      // The room and shared editor serializer must use one Yjs runtime.
      ...(entry === 'src/collab/room/preview.ts' ? ['--external:yjs'] : []),
      '--platform=node',
      '--external:ws',
      '--format=esm',
      '--main-fields=module,main',
      '--target=node20',
      `--outfile=${outfile}`,
      define,
      '--loader:.txt=text',
      '--banner:js=#!/usr/bin/env node',
      '--log-level=warning',
    ],
    { cwd: nodePackage },
  );
  await chmod(outfile, 0o755);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await bundle(join(outDir, 'blok-server.mjs'), false);
await bundle(join(outDir, 'blok-server-conformance.mjs'), true);
await bundle(join(outDir, 'journal-inspect.mjs'), false, 'src/collab/journal/inspect.ts');
await bundle(join(outDir, 'journal-replay.mjs'), false, 'src/collab/journal/replay.ts');
await bundle(join(outDir, 'journal-append.mjs'), false, 'src/collab/journal/append.ts');
await bundle(join(outDir, 'journal-room.mjs'), false, 'src/collab/room/preview.ts');
console.log('Conformance binaries — node: ordinary bundle, and one with BLOK_CONFORMANCE=true.');
