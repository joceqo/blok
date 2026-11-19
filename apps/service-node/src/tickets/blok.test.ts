import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { blokTicket } from './blok.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../test/unit/server-conformance/fixtures/tickets.json',
);
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  secret: string;
  compatible: string;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('blokTicket (shared with @bloklabs/server)', () => {
  it('matches the conformance fixtures compatible token', () => {
    const exp = 4_102_444_800;
    vi.useFakeTimers().setSystemTime(new Date((exp - 300) * 1000));

    const token = blokTicket(fixtures.secret, {
      user: 'u1',
      doc: 'doc-42',
      write: true,
      ttlSeconds: 300,
    });

    expect(token).toBe(fixtures.compatible);
  });
});