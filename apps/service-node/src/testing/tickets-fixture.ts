import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared oracle from `test/unit/server-conformance/fixtures/tickets.json`. */
const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../test/unit/server-conformance/fixtures/tickets.json',
);

export type TicketsConformanceFixture = {
  secret: string;
  compatible: string;
};

export function loadTicketsConformanceFixture(): TicketsConformanceFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as TicketsConformanceFixture;
}