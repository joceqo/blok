const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReorderSibling = {
  id: string;
  sortIndex: number;
};

export type ValidateReorderFailure =
  | 'invalid_request'
  | 'invalid_after_page_id'
  | 'after_is_self'
  | 'after_not_sibling'
  | 'not_sibling';

export type ValidateReorderResult =
  | { ok: true; afterPageId: string | null }
  | { ok: false; reason: ValidateReorderFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateReorder(
  pageId: string,
  body: unknown,
  siblings: ReorderSibling[],
): ValidateReorderResult {
  if (!isRecord(body)) {
    return { ok: false, reason: 'invalid_request' };
  }

  if (!siblings.some((row) => row.id === pageId)) {
    return { ok: false, reason: 'not_sibling' };
  }

  let afterPageId: string | null = null;
  if ('afterPageId' in body) {
    const raw = body.afterPageId;
    if (raw === null) {
      afterPageId = null;
    } else if (raw === undefined) {
      afterPageId = null;
    } else if (typeof raw !== 'string') {
      return { ok: false, reason: 'invalid_after_page_id' };
    } else {
      const trimmed = raw.trim();
      if (!UUID_RE.test(trimmed)) {
        return { ok: false, reason: 'invalid_after_page_id' };
      }
      afterPageId = trimmed;
    }
  }

  if (afterPageId === pageId) {
    return { ok: false, reason: 'after_is_self' };
  }

  if (afterPageId !== null && !siblings.some((row) => row.id === afterPageId)) {
    return { ok: false, reason: 'after_not_sibling' };
  }

  return { ok: true, afterPageId };
}

/** Dense 0..n-1 indices for siblings after inserting `pageId` immediately after `afterPageId`. */
export function sortIndicesAfterReorder(
  pageId: string,
  afterPageId: string | null,
  siblings: ReorderSibling[],
): Map<string, number> {
  const ordered = [...siblings].sort(
    (a, b) => a.sortIndex - b.sortIndex || a.id.localeCompare(b.id),
  );
  const without = ordered.filter((row) => row.id !== pageId);
  let insertAt = 0;
  if (afterPageId !== null) {
    const anchor = without.findIndex((row) => row.id === afterPageId);
    insertAt = anchor < 0 ? without.length : anchor + 1;
  }
  const next = [
    ...without.slice(0, insertAt),
    { id: pageId, sortIndex: 0 },
    ...without.slice(insertAt),
  ];
  const out = new Map<string, number>();
  next.forEach((row, index) => {
    out.set(row.id, index);
  });
  return out;
}