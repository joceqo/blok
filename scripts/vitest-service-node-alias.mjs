import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const serviceSrc = path.join(repositoryRoot, 'apps/service-node/src');

const isServiceNodeModule = (id) => id.includes('apps/service-node');

/**
 * Vitest loads apps/service-node through Vite, not Node's resolver. Map `@/…`
 * only for importers under apps/service-node so blok's own `@/types` alias stays
 * untouched.
 */
export function vitestServiceNodeAlias() {
  return {
    name: 'vitest-service-node-alias',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === undefined || !isServiceNodeModule(importer)) {
        return undefined;
      }
      if (!source.startsWith('@/')) {
        return undefined;
      }

      const withoutPrefix = source.slice(2);
      const asTs = withoutPrefix.endsWith('.js')
        ? `${withoutPrefix.slice(0, -3)}.ts`
        : withoutPrefix;
      const candidate = path.join(serviceSrc, asTs);
      if (existsSync(candidate)) {
        return candidate;
      }
      return undefined;
    },
  };
}