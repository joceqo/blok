/**
 * The server skips a row rather than moving half of it. These hold the same
 * refusals locally, because a body moved under the wrong conditions is worse
 * than a body left where it is.
 */
import { describe, expect, it } from 'vitest';

import { planRowBodyMigration } from './local-row-migration';
import type { OutputData } from '../../types';

const ids = (): (() => string) => {
  const state = { n: 0 };

  return () => `body-${++state.n}`;
};

const pageWith = (row: Record<string, unknown>, extra: Array<Record<string, unknown>> = []): OutputData => ({
  blocks: [
    { id: 'db', type: 'database', data: { schema: [] }, content: ['row'] },
    { id: 'row', type: 'database-row', parent: 'db', content: ['p1'], ...row },
    { id: 'p1', type: 'paragraph', parent: 'row', data: { text: 'corps' } },
    ...extra,
  ],
} as unknown as OutputData);

describe('migrating the rows of a local page', () => {
  it('moves a filled row into its own document and leaves the page naming it', () => {
    const plan = planRowBodyMigration(pageWith({ data: { title: 'Documenter un dépôt', icon: '🐰' } }), ids());

    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.title).toBe('Documenter un dépôt');
    expect(plan.writes[0]?.icon).toBe('🐰');
    expect(plan.writes[0]?.databaseId).toBe('db');
    expect(plan.writes[0]?.body.blocks.map((block) => (block as { id?: string }).id)).toEqual(['p1']);

    const row = plan.source.blocks.find((block) => (block as { id?: string }).id === 'row') as { data: Record<string, unknown> };

    expect(row.data.pageId).toBe('body-1');
    expect(row.data.bodyBlocks).toBe(true);
    expect(plan.source.blocks.map((block) => (block as { id?: string }).id)).toEqual(['db', 'row']);
  });

  it('leaves alone every row the server would leave alone', () => {
    const reasons = (document: OutputData): string[] => planRowBodyMigration(document, ids()).skipped.map((entry) => entry.reason);

    expect(reasons(pageWith({ data: { pageId: 'already' } }))).toEqual(['existing-page']);
    expect(reasons(pageWith({ data: { template: true } }))).toEqual(['template']);
    expect(reasons(pageWith({ data: { properties: { col: { blocks: [{ id: 'x', type: 'paragraph', data: {} }] } } } }))).toEqual(['legacy-body']);
    expect(reasons({ blocks: [
      { id: 'db', type: 'database', data: {}, content: ['row'] },
      { id: 'row', type: 'database-row', parent: 'db', data: {} },
    ] })).toEqual(['empty']);
  });

  it('refuses a row holding a database, which the server refuses too', () => {
    const nested = {
      blocks: [
        { id: 'db', type: 'database', data: {}, content: ['row'] },
        { id: 'row', type: 'database-row', parent: 'db', data: {}, content: ['inner'] },
        { id: 'inner', type: 'database', parent: 'row', data: {} },
      ],
    } as unknown as OutputData;

    expect(planRowBodyMigration(nested, ids()).skipped).toEqual([{ rowId: 'row', reason: 'nested-database' }]);
    expect(planRowBodyMigration(nested, ids()).writes).toEqual([]);
  });

  it('keeps comments on the row and moves the rest', () => {
    const withComment = pageWith(
      { data: { title: 'Ligne' }, content: ['p1', 'c1'] },
      [{ id: 'c1', type: 'database-comment', parent: 'row', data: { text: 'salut' } }],
    );
    const plan = planRowBodyMigration(withComment, ids());

    expect(plan.writes[0]?.body.blocks.map((block) => (block as { id?: string }).id)).toEqual(['p1']);
    const row = plan.source.blocks.find((block) => (block as { id?: string }).id === 'row') as { content?: string[] };

    expect(row.content).toEqual(['c1']);
  });

  it('never modifies the document it was handed', () => {
    const document = pageWith({ data: { title: 'Ligne' } });
    const before = JSON.stringify(document);

    planRowBodyMigration(document, ids());
    expect(JSON.stringify(document)).toBe(before);
  });
});
