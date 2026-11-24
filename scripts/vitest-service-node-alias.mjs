import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const serviceRoot = path.join(repositoryRoot, 'apps/service-node');
const serviceSrc = path.join(serviceRoot, 'src');
const requireFromService = createRequire(path.join(serviceRoot, 'package.json'));

const isServiceNodeModule = (id) => id.includes('apps/service-node');

const isBareSpecifier = (source) =>
  !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('node:') && !source.startsWith('\0');

/**
 * Vitest loads apps/service-node through Vite, not Node's resolver. Map `@/…`
 * only for importers under apps/service-node so blok's own `@/types` alias stays
 * untouched, and resolve npm deps from apps/service-node/node_modules.
 */
export function vitestServiceNodeAlias() {
  return {
    name: 'vitest-service-node-alias',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === undefined || !isServiceNodeModule(importer)) {
        return undefined;
      }

      if (source.startsWith('@/')) {
        const withoutPrefix = source.slice(2);
        const asTs = withoutPrefix.endsWith('.js')
          ? `${withoutPrefix.slice(0, -3)}.ts`
          : withoutPrefix;
        const candidate = path.join(serviceSrc, asTs);
        if (existsSync(candidate)) {
          return candidate;
        }
        return undefined;
      }

      if (isBareSpecifier(source)) {
        try {
          return requireFromService.resolve(source);
        } catch {
          return undefined;
        }
      }

      return undefined;
    },
  };
}