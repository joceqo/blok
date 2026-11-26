/**
 * A double reaches the digest as .NET writes it, which is not how JS writes it.
 * The fixture is the specification; it is never edited to make this pass.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { formatDouble } from './dotnet-double.ts';

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../../../../test/unit/server-conformance/fixtures/canonical-edit-digest.json', import.meta.url)),
  'utf8',
)) as { doubles: { bits: string; json: string; invariant: string }[] };

/** The double those bits stand for. */
function doubleOf(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigInt64(0, BigInt(bits));
  return view.getFloat64(0);
}

it('writes every double the way .NET writes it', () => {
  const wrong = fixture.doubles.flatMap((entry) => {
    const written = formatDouble(doubleOf(entry.bits));
    return written === entry.invariant
      ? []
      : [`${entry.bits}: got ${written}, want ${entry.invariant}`];
  });

  expect(wrong).toEqual([]);
  expect(fixture.doubles).toHaveLength(50);
});

it('writes the same text the JSON writer does', () => {
  const wrong = fixture.doubles.flatMap((entry) =>
    entry.json === entry.invariant ? [] : [entry.bits]);

  expect(wrong).toEqual([]);
});
