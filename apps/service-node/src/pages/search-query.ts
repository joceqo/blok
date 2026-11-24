export const MIN_PAGE_SEARCH_QUERY_LENGTH = 2;
export const PAGE_SEARCH_LIMIT = 20;

export type PageSearchQueryValidation =
  | { ok: true; query: string }
  | { ok: false; reason: 'query_too_short' };

export function searchQueryValid(raw: string | undefined): PageSearchQueryValidation {
  if (raw === undefined) {
    return { ok: false, reason: 'query_too_short' };
  }
  const query = raw.trim();
  if (query.length < MIN_PAGE_SEARCH_QUERY_LENGTH) {
    return { ok: false, reason: 'query_too_short' };
  }
  return { ok: true, query };
}