const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_RESTORE_PAGE_IDS = 50;

export type ValidateRestorePageIdsFailure =
  | 'invalid_request'
  | 'empty_page_ids'
  | 'too_many_page_ids'
  | 'invalid_page_id';

export type ValidateRestorePageIdsResult =
  | { ok: true; pageIds: string[] }
  | { ok: false; reason: ValidateRestorePageIdsFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateRestorePageIds(value: unknown): ValidateRestorePageIdsResult {
  if (!isRecord(value) || !Array.isArray(value.pageIds)) {
    return { ok: false, reason: 'invalid_request' };
  }

  const raw = value.pageIds;
  if (raw.length === 0) {
    return { ok: false, reason: 'empty_page_ids' };
  }
  if (raw.length > MAX_RESTORE_PAGE_IDS) {
    return { ok: false, reason: 'too_many_page_ids' };
  }

  const pageIds: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { ok: false, reason: 'invalid_page_id' };
    }
    const id = entry.trim();
    if (!UUID_RE.test(id)) {
      return { ok: false, reason: 'invalid_page_id' };
    }
    pageIds.push(id);
  }

  return { ok: true, pageIds };
}