import { describe, expect, it } from 'vitest';

import { validateReorder, type ReorderSibling } from './validate-reorder.ts';

const PAGE_A = 'a0000000-0000-4000-8000-000000000001';
const PAGE_B = 'a0000000-0000-4000-8000-000000000002';
const PAGE_C = 'a0000000-0000-4000-8000-000000000003';
const OTHER = 'b0000000-0000-4000-8000-000000000099';

const siblings: ReorderSibling[] = [
  { id: PAGE_A, sortIndex: 0 },
  { id: PAGE_B, sortIndex: 10 },
  { id: PAGE_C, sortIndex: 20 },
];

describe('validateReorder', () => {
  it('rejects non-object bodies', () => {
    expect(validateReorder(PAGE_B, null, siblings)).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('rejects an invalid afterPageId uuid', () => {
    expect(validateReorder(PAGE_B, { afterPageId: 'not-a-uuid' }, siblings)).toEqual({
      ok: false,
      reason: 'invalid_after_page_id',
    });
  });

  it('rejects reordering after itself', () => {
    expect(validateReorder(PAGE_B, { afterPageId: PAGE_B }, siblings)).toEqual({
      ok: false,
      reason: 'after_is_self',
    });
  });

  it('rejects afterPageId that is not a sibling', () => {
    expect(validateReorder(PAGE_B, { afterPageId: OTHER }, siblings)).toEqual({
      ok: false,
      reason: 'after_not_sibling',
    });
  });

  it('rejects when the page is not among siblings', () => {
    expect(validateReorder(OTHER, { afterPageId: PAGE_A }, siblings)).toEqual({
      ok: false,
      reason: 'not_sibling',
    });
  });

  it('allows null afterPageId to mean first among siblings', () => {
    expect(validateReorder(PAGE_C, { afterPageId: null }, siblings)).toEqual({
      ok: true,
      afterPageId: null,
    });
  });

  it('allows omitting afterPageId (first position)', () => {
    expect(validateReorder(PAGE_B, {}, siblings)).toEqual({
      ok: true,
      afterPageId: null,
    });
  });

  it('accepts a sibling afterPageId', () => {
    expect(validateReorder(PAGE_C, { afterPageId: PAGE_A }, siblings)).toEqual({
      ok: true,
      afterPageId: PAGE_A,
    });
  });
});