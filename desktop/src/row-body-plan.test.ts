/**
 * The port of the server's planRowBody. Held to the same rules, because a local
 * workspace that moves a row's body differently from the server would have two
 * meanings for the same document.
 */
import { describe, expect, it } from 'vitest';

import { planRowBody, RowBodyPlanError } from './row-body-plan';
import type { OutputData } from '../../types';

const page = (): OutputData => ({
  blocks: [
    { id: 'db', type: 'database', data: { schema: [] }, content: ['row'] },
    { id: 'row', type: 'database-row', parent: 'db', data: { title: 'Documenter un dépôt' }, content: ['p1', 'toggle', 'c1'] },
    { id: 'p1', type: 'paragraph', parent: 'row', data: { text: 'le corps' } },
    { id: 'toggle', type: 'toggle', parent: 'row', data: {}, content: ['p2'] },
    { id: 'p2', type: 'paragraph', parent: 'toggle', data: { text: 'imbriqué' } },
    { id: 'c1', type: 'database-comment', parent: 'row', data: { text: 'un commentaire' } },
  ],
});

const idsOf = (data: OutputData): string[] => data.blocks.map((block) => (block as { id?: string }).id ?? '');

describe('planning a row body out of its page', () => {
  it('moves the body and leaves the row naming its page', () => {
    const plan = planRowBody(page(), 'row', 'body-1');

    expect(idsOf(plan.body)).toEqual(['p1', 'toggle', 'p2']);
    expect(idsOf(plan.source)).toEqual(['db', 'row', 'c1']);

    const row = plan.source.blocks.find((block) => (block as { id?: string }).id === 'row') as { data: Record<string, unknown>; content?: string[] };

    expect(row.data.pageId).toBe('body-1');
    expect(row.data.bodyBlocks).toBe(true);
    // Comments stay with the row; the rest of its content left.
    expect(row.content).toEqual(['c1']);
  });

  it('detaches the roots of the body but keeps the shape underneath', () => {
    const plan = planRowBody(page(), 'row', 'body-1');
    const moved = new Map(plan.body.blocks.map((block) => [(block as { id?: string }).id, block as { parent?: string }]));

    expect(moved.get('p1')?.parent).toBeUndefined();
    expect(moved.get('toggle')?.parent).toBeUndefined();
    expect(moved.get('p2')?.parent).toBe('toggle');
    expect(plan.descendantIds).toEqual(['p1', 'toggle', 'p2']);
  });

  it('never touches the document it was given', () => {
    const original = page();
    const before = JSON.stringify(original);

    planRowBody(original, 'row', 'body-1');
    expect(JSON.stringify(original)).toBe(before);
  });

  it('drops the row’s content entirely when nothing is retained', () => {
    const source = page();

    source.blocks = source.blocks.filter((block) => (block as { id?: string }).id !== 'c1');
    (source.blocks.find((block) => (block as { id?: string }).id === 'row') as { content: string[] }).content = ['p1', 'toggle'];

    const row = planRowBody(source, 'row', 'body-1').source.blocks
      .find((block) => (block as { id?: string }).id === 'row') as { content?: string[] };

    expect(row.content).toBeUndefined();
  });

  it('accepts a row already moved to the same page, and refuses any other case', () => {
    const moved = planRowBody(page(), 'row', 'body-1').source;

    expect(planRowBody(moved, 'row', 'body-1').alreadyMoved).toBe(true);
    expect(() => planRowBody(moved, 'row', 'other-page')).toThrow(RowBodyPlanError);
  });

  it('refuses a document whose links disagree, rather than losing blocks', () => {
    const orphan = page();

    (orphan.blocks.find((block) => (block as { id?: string }).id === 'row') as { content: string[] }).content = ['p1', 'toggle'];
    expect(() => planRowBody(orphan, 'row', 'body-1')).toThrow(/orphaned or unlisted/);

    const twice = page();

    (twice.blocks.find((block) => (block as { id?: string }).id === 'row') as { content: string[] }).content = ['p1', 'p1', 'toggle', 'c1'];
    expect(() => planRowBody(twice, 'row', 'body-1')).toThrow(/lists a child twice/);
  });

  it('refuses anything that is not a row inside a database', () => {
    expect(() => planRowBody(page(), 'p1', 'body-1')).toThrow(/database row required/);

    const loose = page();

    loose.blocks = [
      { id: 'row', type: 'database-row', data: {}, content: ['p1'] },
      { id: 'p1', type: 'paragraph', parent: 'row', data: {} },
    ];
    expect(() => planRowBody(loose, 'row', 'body-1')).toThrow(/belong to a database/);
  });
});
