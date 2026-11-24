import { describe, expect, it } from 'vitest';

import {
  MAX_RESTORE_PAGE_IDS,
  validateRestorePageIds,
} from './validate-restore-page-ids.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('validateRestorePageIds', () => {
  it('accepts one to fifty UUID page ids', () => {
    const one = [id(1)];
    expect(validateRestorePageIds({ pageIds: one })).toEqual({
      ok: true,
      pageIds: one,
    });

    const fifty = Array.from({ length: MAX_RESTORE_PAGE_IDS }, (_, i) => id(i + 1));
    expect(validateRestorePageIds({ pageIds: fifty })).toEqual({
      ok: true,
      pageIds: fifty,
    });
  });

  it('trims string ids', () => {
    const uuid = id(7);
    expect(validateRestorePageIds({ pageIds: [`  ${uuid}  `] })).toEqual({
      ok: true,
      pageIds: [uuid],
    });
  });

  it('rejects non-object bodies and missing pageIds', () => {
    expect(validateRestorePageIds(null)).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(validateRestorePageIds({})).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(validateRestorePageIds({ pageIds: 'not-array' })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('rejects an empty pageIds array', () => {
    expect(validateRestorePageIds({ pageIds: [] })).toEqual({
      ok: false,
      reason: 'empty_page_ids',
    });
  });

  it(`rejects more than ${MAX_RESTORE_PAGE_IDS} ids`, () => {
    const tooMany = Array.from({ length: MAX_RESTORE_PAGE_IDS + 1 }, (_, i) => id(i + 1));
    expect(validateRestorePageIds({ pageIds: tooMany })).toEqual({
      ok: false,
      reason: 'too_many_page_ids',
    });
  });

  it('rejects a non-uuid page id', () => {
    expect(validateRestorePageIds({ pageIds: [id(1), 'not-a-uuid'] })).toEqual({
      ok: false,
      reason: 'invalid_page_id',
    });
  });
});