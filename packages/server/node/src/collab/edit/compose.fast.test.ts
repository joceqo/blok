/**
 * The ops the agent builds in memory, written back out in the canonical form
 * and digested. The fixture captured from C# is the specification: it is never
 * edited to make a test pass.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { canonicalBody, canonicalBodyDigest, type EditOp } from './compose.ts';

interface AgentCase {
  name: string;
  lastEditedAtBits: string | null;
  canonical: string;
  digestHex: string;
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../../../../test/unit/server-conformance/fixtures/canonical-edit-digest.json', import.meta.url)),
  'utf8',
)) as { agent: AgentCase[] };

/** The double those bits stand for, so a time survives the trip through JSON. */
function doubleOf(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigInt64(0, BigInt(bits));
  return view.getFloat64(0);
}

/** setMetadata on "u", which is every case that differs only by its time. */
const timed = (lastEditedAt: number): EditOp =>
  ({ op: 'setMetadata', id: 'b1', lastEditedAt, lastEditedBy: 'u' });

/** The op each captured case was built from, named as C#'s AgentOps() names it. */
const BUILDERS: Record<string, (lastEditedAt: number) => EditOp> = {
  'move': () => ({ op: 'move', id: 'b1', after: 'b0', parent: 'p1' }),
  'move to the start of the root': () => ({ op: 'move', id: 'b1' }),
  'lift': () => ({ op: 'lift', id: 'b1' }),
  'retype': () => ({ op: 'retype', id: 'b1', type: 'header', data: { z: 1, a: 'é', level: 2.5 } }),
  'setTunes': () => ({ op: 'setTunes', id: 'b1', tunes: { align: 'left', anchor: null } }),
  'setMetadata': (at) => ({ op: 'setMetadata', id: 'b1', lastEditedAt: at, lastEditedBy: 'user-1' }),
  'setMetadata with': (at) =>
    ({ op: 'setMetadata', id: 'b1', lastEditedAt: at, lastEditedBy: 'u<1>', lastEditedWith: 'agent' }),
  'setMetadata large': timed,
  'setMetadata small': timed,
  'setMetadata negative zero': timed,
  'setMetadata max': timed,
  'setPageField': () => ({ op: 'setPageField', key: 'title', value: 'Hi' }),
  'setPageField null': () => ({ op: 'setPageField', key: 'icon', value: null }),
  'setPageField object': () => ({ op: 'setPageField', key: 'icon', value: { value: 'x', type: 'emoji' } }),
};

const built = fixture.agent.map((entry) => ({
  entry,
  op: BUILDERS[entry.name]?.(entry.lastEditedAtBits === null ? 0 : doubleOf(entry.lastEditedAtBits)),
}));

it('writes every op the agent builds in the canonical form the fixture captured', () => {
  const wrong = built.flatMap(({ entry, op }) =>
    op !== undefined && canonicalBody([op]) === entry.canonical
      ? []
      : [`${entry.name}: got ${op === undefined ? 'no op' : canonicalBody([op])}, want ${entry.canonical}`]);

  expect(wrong).toEqual([]);
  expect(fixture.agent).toHaveLength(14);
});

it('digests the canonical form of the ops it built', () => {
  const wrong = built.flatMap(({ entry, op }) =>
    op !== undefined && canonicalBodyDigest([op]) === entry.digestHex ? [] : [entry.name]);

  expect(wrong).toEqual([]);
});

it('takes the digest over the canonical bytes, which is a plain SHA-256 of them', () => {
  const wrong = fixture.agent.flatMap((entry) =>
    createHash('sha256').update(entry.canonical, 'utf8').digest('hex') === entry.digestHex ? [] : [entry.name]);

  expect(wrong).toEqual([]);
});

it('writes several ops in the order they were given', () => {
  const ops: EditOp[] = [{ op: 'lift', id: 'b1' }, { op: 'move', id: 'b2' }];

  expect(canonicalBody(ops)).toBe(
    '{"ops":[{"id":"b1","op":"lift"},{"after":null,"id":"b2","op":"move","parent":null}]}');
});

it('refuses a map patch, which restore builds and no digest covers', () => {
  expect(() => canonicalBody([{ op: 'patchMaps' }])).toThrow(/map patch comes only from restore/);
});

/**
 * A number built in memory carries no source text to preserve, so every one of
 * them -- nested in data, tunes or value, not only lastEditedAt -- goes through
 * the .NET writer. The captured cases only carry 1 and 2.5, which JS spells the
 * same way, so nothing above would notice if a nested number stopped doing so.
 */
it('writes a nested number the .NET way, not the JS way', () => {
  const body = canonicalBody([
    { op: 'retype', id: 'b', type: 'p', data: { big: 1e21, small: 1e-5, zero: -0 } },
  ]);

  expect(body).toContain('"big":1E+21');
  expect(body).toContain('"small":1E-05');
  expect(body).toContain('"zero":-0');
});
