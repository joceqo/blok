/**
 * Stamp authority, against the fixture captured from C#. That file is the
 * specification: it is never edited to make a test pass.
 *
 * The fixture spells each answer as a canonical body, because that is what the
 * endpoints compare. Nothing here writes a canonical form of ops built in
 * memory — `compose` writes the agent ops only — so the expectation is read
 * back out of that text with `JSON.parse`, which the stamped values are then
 * compared against one op at a time.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { canonicalEdit } from './canonical.ts';
import { stampAuthority } from './stamp.ts';
import type { EditCommand } from './canonical.ts';

interface StampCase {
  name: string;
  actor: string | null;
  nowMs: number;
  body: string;
  canonical: string;
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL(
    '../../../../../../test/unit/server-conformance/fixtures/collab-edits/stamp-authority.json',
    import.meta.url,
  )),
  'utf8',
)) as { cases: StampCase[] };

/** The ops a fixture body parses to, which is what the endpoint hands the stamper. */
function opsOf(body: string): EditCommand[] {
  const parsed = canonicalEdit(body);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.ops;
}

const expectedOf = (canonical: string): unknown[] =>
  (JSON.parse(canonical) as { ops: unknown[] }).ops;

it('answers every fixture case the way C# does', () => {
  const wrong = fixture.cases.flatMap((entry) => {
    const stamped = stampAuthority(opsOf(entry.body), { by: entry.actor }, entry.nowMs);
    const expected = expectedOf(entry.canonical);
    return JSON.stringify(sorted(stamped)) === JSON.stringify(sorted(expected))
      ? []
      : [[entry.name, sorted(stamped), sorted(expected)]];
  });

  expect(wrong).toEqual([]);
  expect(fixture.cases.length).toBe(7);
});

/** Members sorted the way the canonical form sorts them, so two shapes compare as text. */
function sorted(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sorted);
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
      .map(([name, member]) => [name, sorted(member)]),
  );
}

it('credits the agent that acted for a person as the co-author, on an insert and an update', () => {
  const ops = opsOf(JSON.stringify({ ops: [
    { op: 'insert', id: 'b1', block: { type: 'paragraph', data: {}, createdBy: 'mallory' } },
    { op: 'update', id: 'b0', data: { text: 'new' } },
  ] }));

  const stamped = stampAuthority(ops, { by: 'alice', with: 'agent:alice:claude-code' }, 1762776000000);

  expect(stamped).toEqual([
    { op: 'insert', id: 'b1', parent: null, after: null, block: {
      type: 'paragraph',
      data: {},
      createdAt: 1762776000000,
      lastEditedAt: 1762776000000,
      createdBy: 'alice',
      lastEditedBy: 'alice',
      createdWith: 'agent:alice:claude-code',
      lastEditedWith: 'agent:alice:claude-code',
    } },
    { op: 'update', id: 'b0', data: { text: 'new' } },
    { op: 'setMetadata', id: 'b0', lastEditedAt: 1762776000000, lastEditedBy: 'alice',
      lastEditedWith: 'agent:alice:claude-code' },
  ]);
});

it('stamps the whole batch at the one instant it is given, and leaves the ops it was given alone', () => {
  const ops = opsOf(JSON.stringify({ ops: [
    { op: 'insert', id: 'b1', block: { type: 'paragraph', data: {}, createdAt: 1 } },
    { op: 'insert', id: 'b2', after: 'b1', block: { type: 'paragraph', data: {} } },
  ] }));
  const before = JSON.stringify(ops);

  const stamped = stampAuthority(ops, { by: 'u1' }, 1762776000000);

  expect(stamped.map((op) => ('block' in op ? op.block.createdAt : null)))
    .toEqual([1762776000000, 1762776000000]);
  expect(JSON.stringify(ops)).toBe(before);
});
