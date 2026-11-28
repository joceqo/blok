import { describe, expect, it } from 'vitest';

import { DISPLAY_NAME_MAX_LEN, normalizeDisplayName } from './display-name.ts';

describe('normalizeDisplayName', () => {
  it('trims and keeps non-empty values', () => {
    expect(normalizeDisplayName('  Alex  ')).toEqual({ ok: true, value: 'Alex' });
  });

  it('maps whitespace-only strings to null', () => {
    expect(normalizeDisplayName('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts null as clear', () => {
    expect(normalizeDisplayName(null)).toEqual({ ok: true, value: null });
  });

  it('rejects overlong names', () => {
    const long = 'a'.repeat(DISPLAY_NAME_MAX_LEN + 1);
    expect(normalizeDisplayName(long)).toEqual({ ok: false, reason: 'display_name_too_long' });
  });
});