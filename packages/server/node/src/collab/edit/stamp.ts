/**
 * Stamp authority: the optional mode where the server, not the caller, says
 * who wrote a block and when.
 *
 * It is off by default — without it an insert keeps whatever stamps the client
 * sent. With it on, the endpoint runs this AFTER taking the request digest, so
 * the digest is of the body as sent and a retry of that body still matches.
 *
 * An insert loses all six of its stamps and is given fresh ones: both times
 * are `nowMs`, the author and the agent come from the attribution, and a field
 * nobody is named for is left out rather than written empty. An update cannot
 * carry stamps of its own, so it is FOLLOWED by a `setMetadata` of the same
 * block; with no author known there is nobody to credit and none is added. A
 * remove is passed through untouched.
 *
 * One `nowMs` is read for the whole request, so every op of one edit carries
 * the same instant.
 */

import type { EditCommand, EditValue } from './canonical.ts';
import type { SetMetadata } from './compose.ts';

/** Who the edit is credited to. */
export interface Attribution {
  /** The author. Empty or null when no actor is known: then only the times are written. */
  by: string | null;
  /** The agent that edited for `by`, when one did. */
  with?: string | null;
}

/** An op of the request, plus the stamps an update needs a second op to carry. */
export type StampedOp = EditCommand | SetMetadata;

/** The six a block carries, every one of which the caller loses. */
const STAMPS = new Set([
  'createdAt', 'createdBy', 'createdWith', 'lastEditedAt', 'lastEditedBy', 'lastEditedWith',
]);

/** A pair per field, or none at all when nobody is named. */
const credit = (names: [string, string], who: string): [string, EditValue][] =>
  who === '' ? [] : names.map((name) => [name, who]);

function stamped(
  block: Record<string, EditValue>,
  by: string,
  tool: string,
  nowMs: number,
): Record<string, EditValue> {
  const kept = Object.entries(block).filter(([name]) => !STAMPS.has(name));
  return Object.fromEntries([
    ...kept,
    ['createdAt', nowMs] as [string, EditValue],
    ['lastEditedAt', nowMs] as [string, EditValue],
    ...credit(['createdBy', 'lastEditedBy'], by),
    ...credit(['createdWith', 'lastEditedWith'], tool),
  ]);
}

const metadata = (id: string, by: string, tool: string, nowMs: number): SetMetadata => ({
  op: 'setMetadata',
  id,
  lastEditedAt: nowMs,
  lastEditedBy: by,
  // Asymmetric with the block's stamps on purpose, as `compose` writes it: an
  // agent nobody named is left out of the op, not written `null` in it.
  ...(tool === '' ? {} : { lastEditedWith: tool }),
});

/** The ops to apply, which the caller's own ops are never mutated into. */
export function stampAuthority(
  ops: readonly EditCommand[],
  attribution: Attribution,
  nowMs: number,
): StampedOp[] {
  const by = attribution.by ?? '';
  const tool = attribution.with ?? '';
  return ops.flatMap((op): StampedOp[] => {
    if (op.op === 'insert') return [{ ...op, block: stamped(op.block, by, tool, nowMs) }];
    if (op.op === 'update' && by !== '') return [op, metadata(op.id, by, tool, nowMs)];
    return [op];
  });
}
