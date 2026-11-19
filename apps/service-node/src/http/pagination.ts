export const MIN_LIST_LIMIT = 1;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = MAX_LIST_LIMIT;

export type ListPaginationQuery = {
  paginated: boolean;
  limit: number;
  cursor: string | undefined;
};

export function clampListLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(MAX_LIST_LIMIT, Math.max(MIN_LIST_LIMIT, parsed));
}

export function parseListPagination(
  searchParams: URLSearchParams | Record<string, string | undefined>,
  defaultLimit: number = DEFAULT_LIST_LIMIT,
): ListPaginationQuery {
  const get = (key: 'limit' | 'cursor'): string | undefined => {
    if (searchParams instanceof URLSearchParams) {
      const value = searchParams.get(key);
      return value === null ? undefined : value;
    }
    return searchParams[key];
  };

  const rawLimit = get('limit');
  const cursorRaw = get('cursor');
  const hasLimit = rawLimit !== undefined;
  const hasCursor = cursorRaw !== undefined && cursorRaw !== '';
  const paginated = hasLimit || hasCursor;

  const clamped = clampListLimit(rawLimit);
  const limit = clamped ?? defaultLimit;

  return {
    paginated,
    limit,
    cursor: hasCursor ? cursorRaw : undefined,
  };
}

const CURSOR_SEP = '\n';

export function encodeTimeIdCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}${CURSOR_SEP}${id}`, 'utf8').toString('base64url');
}

export function decodeTimeIdCursor(cursor: string): { at: Date; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new Error('invalid_cursor');
  }
  const sep = decoded.indexOf(CURSOR_SEP);
  if (sep < 0) {
    throw new Error('invalid_cursor');
  }
  const atRaw = decoded.slice(0, sep);
  const id = decoded.slice(sep + CURSOR_SEP.length);
  const at = new Date(atRaw);
  if (Number.isNaN(at.getTime()) || id === '') {
    throw new Error('invalid_cursor');
  }
  return { at, id };
}