import { describe, expect, it } from 'vitest';

import {
  buildPagesTree,
  collectDescendantIds,
  type PageTreeRow,
  wouldCreatePageCycle,
} from './tree.js';

function row(
  id: string,
  title: string,
  parentId: string | null,
): PageTreeRow {
  return {
    id,
    title,
    parentId,
    trashed: false,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

const nestedFixture: PageTreeRow[] = [
  row('root-a', 'Alpha', null),
  row('root-b', 'Beta', null),
  row('child-a1', 'A one', 'root-a'),
  row('child-a2', 'A two', 'root-a'),
  row('grand-a1', 'A1 child', 'child-a1'),
];

describe('buildPagesTree', () => {
  it('builds nested children from flat rows', () => {
    const tree = buildPagesTree(nestedFixture);

    expect(tree).toHaveLength(2);
    expect(tree.map((n) => n.id)).toEqual(['root-a', 'root-b']);

    const alpha = tree[0];
    expect(alpha).toBeDefined();
    expect(alpha?.children.map((n) => n.id)).toEqual(['child-a1', 'child-a2']);

    const aOne = alpha?.children[0];
    expect(aOne?.children.map((n) => n.id)).toEqual(['grand-a1']);
  });

  it('sorts siblings by title', () => {
    const tree = buildPagesTree([
      row('z', 'Zulu', null),
      row('a', 'Alpha', null),
      row('m', 'Mike', null),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'm', 'z']);
  });

  it('treats rows with missing parent as roots', () => {
    const tree = buildPagesTree([row('orphan', 'Lonely', 'missing-parent')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe('orphan');
    expect(tree[0]?.children).toEqual([]);
  });
});

describe('collectDescendantIds', () => {
  it('returns direct and nested descendants', () => {
    const ids = collectDescendantIds('root-a', nestedFixture);
    expect([...ids].sort()).toEqual(['child-a1', 'child-a2', 'grand-a1']);
  });

  it('returns empty when there are no children', () => {
    expect(collectDescendantIds('root-b', nestedFixture).size).toBe(0);
  });
});

describe('wouldCreatePageCycle', () => {
  it('detects self-parent and descendant-parent moves', () => {
    expect(wouldCreatePageCycle('child-a1', 'child-a1', nestedFixture)).toBe(true);
    expect(wouldCreatePageCycle('root-a', 'grand-a1', nestedFixture)).toBe(true);
    expect(wouldCreatePageCycle('root-a', 'root-b', nestedFixture)).toBe(false);
    expect(wouldCreatePageCycle('child-a1', null, nestedFixture)).toBe(false);
  });
});