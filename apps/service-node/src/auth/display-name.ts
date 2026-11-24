export const DISPLAY_NAME_MAX_LEN = 128;

export type DisplayNameNormalization =
  | { ok: true; value: string | null }
  | { ok: false; reason: 'display_name_too_long' };

/** Trim; empty → null; null clears. */
export function normalizeDisplayName(raw: string | null): DisplayNameNormalization {
  if (raw === null) {
    return { ok: true, value: null };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > DISPLAY_NAME_MAX_LEN) {
    return { ok: false, reason: 'display_name_too_long' };
  }
  return { ok: true, value: trimmed };
}