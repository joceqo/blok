import { describe, expect, it } from 'vitest';

import { MIN_PAGE_SEARCH_QUERY_LENGTH, searchQueryValid } from './search-query.js';

describe('searchQueryValid', () => {
  it('accepts trimmed queries at least two characters', () => {
    expect(searchQueryValid('  ab  ')).toEqual({ ok: true, query: 'ab' });
    expect(searchQueryValid('roadmap')).toEqual({ ok: true, query: 'roadmap' });
  });

  it(`rejects shorter than ${MIN_PAGE_SEARCH_QUERY_LENGTH} after trim`, () => {
    expect(searchQueryValid(undefined)).toEqual({ ok: false, reason: 'query_too_short' });
    expect(searchQueryValid('')).toEqual({ ok: false, reason: 'query_too_short' });
    expect(searchQueryValid('   ')).toEqual({ ok: false, reason: 'query_too_short' });
    expect(searchQueryValid('a')).toEqual({ ok: false, reason: 'query_too_short' });
  });
});