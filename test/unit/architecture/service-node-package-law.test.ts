// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

const TICKETS_FIXTURE = 'test/unit/server-conformance/fixtures/tickets.json';

describe('service-node package law', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not ship drizzle-kit migrate or generate scripts', () => {
    const pkg = read('apps/service-node/package.json');
    expect(pkg).not.toMatch(/drizzle-kit/);
    for (const forbidden of ['migrate', 'generate', 'push', 'pull']) {
      expect(pkg).not.toContain(`"drizzle-kit ${forbidden}"`);
    }
  });

  it('anchors blok tickets to the shared server conformance fixture', () => {
    const loader = read('apps/service-node/src/testing/tickets-fixture.ts');
    const hmacTest = read('apps/service-node/src/tickets/hmac.test.ts');

    expect(loader).toContain(TICKETS_FIXTURE);
    expect(hmacTest).toContain('@/testing/tickets-fixture.js');
  });

  it('uses @/ import aliases instead of deep relative paths', () => {
    const pkg = read('apps/service-node/package.json');
    const routes = read('apps/service-node/src/routes/workspaces.ts');

    expect(pkg).toContain('"@/*"');
    expect(routes).toMatch(/from '@\//);
    expect(routes).not.toMatch(/from '\.\.\/\.\./);
  });

  it('keeps schema.sql as the bootstrap source of truth', () => {
    const sql = read('apps/service-node/schema.sql');
    expect(sql).toContain('CREATE TABLE');
    expect(read('apps/service-node/README.md')).toMatch(/schema\.sql/i);
  });

  it('exposes a root runner that delegates to apps/service-node', () => {
    expect(read('scripts/test-service-node.mjs')).toContain('apps/service-node');
  });
});