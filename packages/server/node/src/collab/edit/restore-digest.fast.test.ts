/**
 * The restore digest, against the fixtures captured from C#.
 * Those files are the specification: they are never edited to make a test pass.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { restoreDigest } from './restore-digest.ts';

const read = (name: string): unknown => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../../../../../test/unit/server-conformance/fixtures/${name}`, import.meta.url)),
  'utf8',
));

const canonical = read('canonical-edit-digest.json') as {
  restore: { lineage: string; sequence: string; digestHex: string }[];
};
const scope = read('collab-history/restore-scope.json') as {
  digests: { lineage: string; sequence: string; databases: string; digestHex: string }[];
};

it('digests the request line of a restore, sequences past 2^53 included', () => {
  const wrong = canonical.restore.flatMap((entry) => {
    const digest = restoreDigest(entry.lineage, BigInt(entry.sequence), false).toString('hex');
    return digest === entry.digestHex ? [] : [`${entry.lineage}:${entry.sequence}`];
  });

  expect(wrong).toEqual([]);
  expect(canonical.restore.length).toBeGreaterThan(0);
  // The case the formula exists for: ulong.MaxValue is not a safe Number.
  expect(canonical.restore.map((entry) => entry.sequence)).toContain('18446744073709551615');
});

it('ends the line in \\nkeep when the databases are kept, so one key is two edits', () => {
  const wrong = scope.digests.flatMap((entry) => {
    const digest = restoreDigest(entry.lineage, BigInt(entry.sequence), entry.databases === 'keep');
    return digest.toString('hex') === entry.digestHex ? [] : [entry.databases];
  });

  expect(wrong).toEqual([]);
  expect(scope.digests.map((entry) => entry.databases).sort()).toEqual(['keep', 'restore']);
});
