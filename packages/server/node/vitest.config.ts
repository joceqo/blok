import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Fast tier: in-process Vitest + Zod (low memory). Full parity: scripts/test-server-conformance.mjs. */
export default defineConfig({
  cacheDir: path.resolve(dirname, '../../../node_modules/.vite/server-node'),
  resolve: { alias: { yjs: path.join(dirname, 'node_modules/yjs') } },
  test: {
    root: dirname,
    environment: 'node',
    pool: 'threads',
    // Each file gets its own module graph. Shared, the suite was not
    // reproducible: files that run a real room or server failed under load, a
    // different set every pass, all green on their own. A test whose verdict
    // depends on what ran beside it proves nothing. Measured at no cost here.
    isolate: true,
    fileParallelism: true,
    include: ['src/**/*.fast.test.ts', 'src/**/*.test.ts'],
    exclude: ['dist/**'],
    name: 'server-node-fast',
  },
});