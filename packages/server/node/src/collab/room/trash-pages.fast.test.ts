/**
 * The target a restore writes when `CollabRestoreTrashesPages` is on, against
 * the shared planner fixtures. Those files are the specification: they are
 * never edited to make a test pass.
 */

import { readFileSync } from 'node:fs';
import { applyUpdate, Doc } from 'yjs';
import { expect, it } from 'vitest';
import { trashPages, type RestoreTrash } from './trash-pages.ts';
import { exportPage } from './page-document.ts';
import type { OutputData } from '../../../../../../types/data-formats/output-data.ts';

interface PlanOp {
  op: string;
  id: string;
  after?: string | null;
  parent?: string | null;
  data?: Record<string, unknown>;
  block?: { type: string; data: Record<string, unknown> };
}
interface Fixture {
  name: string;
  current: string;
  target: string;
  trash?: RestoreTrash;
  ops: PlanOp[];
}

const { cases } = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../../test/unit/server-conformance/fixtures/collab-history/restore-plans.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cases: Fixture[] };

function page(bytes: string): OutputData {
  const d = new Doc();
  try {
    applyUpdate(d, Buffer.from(bytes, 'base64'));
    return exportPage(d, {}) as unknown as OutputData;
  } finally {
    d.destroy();
  }
}

const trashed = cases.filter((entry): entry is Fixture & { trash: RestoreTrash } => entry.trash !== undefined);

it.each(trashed)('writes the stamps the shared planner writes: $name', (entry) => {
  const target = page(entry.target);
  const blocks = trashPages(page(entry.current), target, entry.trash);
  const stamped = entry.ops.filter((op) => (op.data ?? op.block?.data)?.trashed !== undefined);

  for (const op of stamped) {
    expect(blocks.find((block) => block.id === op.id)?.data).toEqual(op.data ?? op.block?.data);
  }
  // A pointer the target already holds stays the target's, stamps included.
  for (const block of target.blocks) {
    expect(blocks.find((other) => other.id === block.id)).toEqual(block);
  }
});

/** The fixture case by name; a renamed case must fail loudly, not silently skip. */
function named(name: string): Fixture & { trash: RestoreTrash } {
  const entry = trashed.find((c) => c.name === name);

  if (entry === undefined) throw new Error('No such restore-plans case: ' + name);

  return entry;
}

it('keeps a pointer among its live siblings at the root', () => {
  const entry = named('trashes a later page pointer in place');
  const blocks = trashPages(page(entry.current), page(entry.target), entry.trash);

  expect(blocks.map((block) => block.id)).toEqual(['a', 'pg', 'b']);
  expect(blocks.find((block) => block.id === 'pg')?.parent).toBeUndefined();
});

it('keeps a pointer among its live siblings under a parent the target keeps', () => {
  const entry = named('a later page pointer keeps its place under a kept parent');
  const blocks = trashPages(page(entry.current), page(entry.target), entry.trash);
  const pointer = blocks.find((block) => block.id === 'pg');

  expect(blocks.filter((block) => block.parent === 't').map((block) => block.id)).toEqual(['k1', 'pg', 'k2']);
  expect(pointer?.parent).toBe('t');
});

it('sends a pointer whose parent the target lacks to the end of the root', () => {
  const entry = named('a later page pointer whose parent is also later goes to the root');
  const blocks = trashPages(page(entry.current), page(entry.target), entry.trash);

  expect(blocks.map((block) => block.id)).toEqual(['a', 'pg']);
  expect(blocks.find((block) => block.id === 'pg')?.parent).toBeUndefined();
});

it('leaves the target alone when it holds no live page pointer of its own', () => {
  const entry = cases.find((c) => c.name === 'a later page pointer is removed without trash');
  const target = page(entry?.target ?? '');
  const blocks = trashPages(page(entry?.current ?? ''), target, { by: 'u9', at: 1 });

  // The same case without trashing: the pointer comes back, so the target grew by one.
  expect(blocks.length).toBe(target.blocks.length + 1);
  expect(target.blocks.some((block) => block.id === 'pg')).toBe(false);
});
