import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const nativeOptionals = ['pg-native', 'bufferutil', 'utf-8-validate', 'cloudflare:sockets'];

async function packageNotices(dest, results) {
  const packages = new Map();
  for (const { metafile } of results) {
    for (const output of Object.values(metafile.outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        if (!bytesInOutput || !input.includes('node_modules/')) continue;
        const pathToFile = resolve(root, input);
        const start = pathToFile.lastIndexOf('/node_modules/') + '/node_modules/'.length;
        const parts = pathToFile.slice(start).split('/');
        const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        const path = pathToFile.slice(0, start) + name;
        packages.set(path, name);
      }
    }
  }
  const entries = [];
  for (const [dir, name] of packages) {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const folder = join(dest, name.replace('/', '+') + '-' + pkg.version);
    await mkdir(folder, { recursive: true });
    const files = (await readdir(dir, { withFileTypes: true })).filter(file => file.isFile() && /^(licen[sc]e|copyright|notice|copying)(?:[._-]|$)/i.test(file.name));
    for (const { name: filename } of files) await copyFile(join(dir, filename), join(folder, filename));
    const record = { name, version: pkg.version, license: pkg.license, author: pkg.author, repository: pkg.repository };
    if (!files.length) {
      const readme = (await readdir(dir)).find(file => /^readme(?:\.|$)/i.test(file));
      if (readme) await copyFile(join(dir, readme), join(folder, basename(readme)));
    }
    await writeFile(join(folder, 'package.json'), JSON.stringify(record, null, 2) + '\n');
    entries.push(record);
  }
  await writeFile(join(dest, 'packages.json'), JSON.stringify(entries.sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n');
}

export async function bundleServices(destination) {
  const mcp = JSON.parse(await readFile(join(root, 'packages/mcp/package.json'), 'utf8'));
  const shared = {
    absWorkingDir: root, platform: 'node', target: 'node24', format: 'esm',
    preserveSymlinks: true, bundle: true, metafile: true, mainFields: ['module', 'main'], loader: { '.txt': 'text' },
    // The journal and editor serializer must share the same Y.Doc constructors.
    alias: { yjs: join(root, 'packages/server/node/node_modules/yjs/dist/yjs.mjs') },
    external: nativeOptionals, logLevel: 'warning',
    banner: { js: "import {createRequire as __blokCreateRequire} from 'node:module'; const require = __blokCreateRequire(import.meta.url);" },
  };
  const bundle = (entry, out, extra = {}) => build({
    ...shared, entryPoints: [entry], outfile: join(destination, out), ...extra,
  });
  const results = await Promise.all([
    bundle('apps/service-node/src/shell/main.ts', 'app/dist/shell/main.mjs'),
    bundle('apps/service-node/mcp/runtime.ts', 'app/dist/shell/mcp-runtime.mjs', { define: { VERSION: JSON.stringify(mcp.version) } }),
    bundle('packages/server/node/src/main.ts', 'room/media.mjs', { define: { BLOK_CONFORMANCE: 'false' } }),
    bundle('packages/server/node/bin/blok-journal-room.mjs', 'room/room.mjs', {
      plugins: [{
        name: 'journal-entry',
        setup(plugin) {
          plugin.onResolve({ filter: /^\.\.\/dist\/journal-room\.mjs$/ }, () => ({
            path: join(root, 'packages/server/node/src/collab/room/preview.ts'),
          }));
        },
      }],
    }),
  ]);
  await writeFile(join(destination, 'app/main.mjs'), "import './dist/shell/main.mjs';\n");
  await copyFile(join(root, 'apps/service/schema.sql'), join(destination, 'app/schema.sql'));
  await packageNotices(join(destination, 'licenses/javascript'), results);
}

export function bundleSupervisor(destination) {
  return build({
    absWorkingDir: root, entryPoints: ['desktop/runtime/supervisor.ts'], outfile: join(destination, 'supervisor.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    nodePaths: [join(root, 'apps/service-node/node_modules')], external: nativeOptionals,
    banner: { js: "import {createRequire as __blokCreateRequire} from 'node:module'; const require = __blokCreateRequire(import.meta.url);" },
  });
}
