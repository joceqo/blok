/**
 * The canonical form and its digest, against the fixture captured from C#.
 * That file is the specification: it is never edited to make a test pass.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { canonicalEdit, operationIdForKey } from './canonical.ts';

interface ParseCase {
  name: string;
  body?: string;
  bodyHex?: string;
  canonical?: string;
  digestHex?: string;
  error?: string;
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../../../../test/unit/server-conformance/fixtures/canonical-edit-digest.json', import.meta.url)),
  'utf8',
)) as { parse: ParseCase[]; keys: { key: string; operationId: string | null }[] };

/** The bodies the parser accepts, which are the ones that have a canonical form. */
const accepted = fixture.parse.flatMap((entry) =>
  entry.canonical === undefined || entry.body === undefined
    ? []
    : [{ name: entry.name, body: entry.body, canonical: entry.canonical, digestHex: entry.digestHex }]);

it('rewrites every accepted body into the canonical form the fixture captured', () => {
  const wrong = accepted.flatMap((entry) => {
    const result = canonicalEdit(entry.body);
    return 'canonical' in result && result.canonical === entry.canonical ? [] : [entry.name];
  });

  expect(wrong).toEqual([]);
  expect(accepted.length).toBeGreaterThan(0);
});

it('digests the canonical form, not the body it was sent as', () => {
  const wrong = accepted.flatMap((entry) => {
    const result = canonicalEdit(entry.body);
    if (!('canonical' in result)) return [entry.name];
    const digest = createHash('sha256').update(result.canonical, 'utf8').digest('hex');
    return digest === entry.digestHex ? [] : [entry.name];
  });

  expect(wrong).toEqual([]);
});

it('derives an operation id from the idempotency key, and refuses the keys the fixture refuses', () => {
  const wrong = fixture.keys.flatMap(({ key, operationId }) =>
    operationIdForKey(key) === operationId ? [] : [JSON.stringify(key)]);

  expect(wrong).toEqual([]);
});

/** Every body the fixture refuses, with the words it refuses them in. */
const refused = fixture.parse.flatMap((entry) =>
  entry.error === undefined ? [] : [{ ...entry, error: entry.error }]);

it('refuses every body the fixture refuses, in the same words', () => {
  const wrong = refused.flatMap((entry) => {
    const body = entry.body !== undefined
      ? new TextEncoder().encode(entry.body)
      : Uint8Array.from(Buffer.from(entry.bodyHex ?? '', 'hex'));
    const result = canonicalEdit(body);
    if (!('error' in result)) return [`${entry.name}: accepted, expected a refusal`];
    return result.error === entry.error
      ? []
      : [`${entry.name}: got ${JSON.stringify(result.error)} want ${JSON.stringify(entry.error)}`];
  });

  expect(wrong).toEqual([]);
  expect(refused.length).toBe(74);
});
