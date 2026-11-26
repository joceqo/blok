/**
 * A row can be deleted from its menu, from a table, or by an undo, and none of
 * those paths knows a file now belongs to it. The page itself says who is still
 * there: a body no row names has nobody left to open it. But an empty read is
 * what a truncated file looks like too — and then the bodies are the only copy
 * of that work.
 */
import { describe, expect, it } from 'vitest';

import type { OutputData } from '../../types';

/** The rule under test, as the workspace applies it. */
const reap = (held: string[], data: OutputData): string[] => {
  if (held.length === 0 || !Array.isArray(data.blocks) || data.blocks.length === 0) return [];

  const named = new Set(data.blocks
    .map((block) => (block as { data?: { pageId?: unknown } }).data?.pageId)
    .filter((value): value is string => typeof value === 'string'));

  return held.filter((bodyId) => !named.has(bodyId));
};

const pageNaming = (...pageIds: string[]): OutputData => ({
  blocks: [
    { id: 'db', type: 'database', data: {} },
    ...pageIds.map((pageId, index) => ({ id: `row-${index}`, type: 'database-row', parent: 'db', data: { pageId } })),
  ],
});

describe('reaping the bodies of rows that are gone', () => {
  it('deletes the body of a row that no longer names it', () => {
    expect(reap(['body-1', 'body-2'], pageNaming('body-1'))).toEqual(['body-2']);
  });

  it('keeps every body still named', () => {
    expect(reap(['body-1', 'body-2'], pageNaming('body-1', 'body-2'))).toEqual([]);
  });

  it('deletes nothing when the page reads empty, which is what a truncated file looks like', () => {
    expect(reap(['body-1'], { blocks: [] })).toEqual([]);
    expect(reap(['body-1'], {} as OutputData)).toEqual([]);
  });

  it('deletes nothing when no body is held for that page', () => {
    expect(reap([], pageNaming())).toEqual([]);
  });
});
