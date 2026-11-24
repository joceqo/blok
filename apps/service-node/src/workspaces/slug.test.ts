import { describe, expect, it } from 'vitest';

import { slugFromName, validateWorkspaceSlug } from './slug.ts';

describe('validateWorkspaceSlug', () => {
  it('accepts a lowercase slug', () => {
    expect(validateWorkspaceSlug('my-team')).toEqual({ ok: true, slug: 'my-team' });
  });

  it('rejects uppercase', () => {
    expect(validateWorkspaceSlug('My-Team')).toEqual({ ok: false, reason: 'invalid_slug' });
  });

  it('rejects empty and leading or trailing hyphens', () => {
    expect(validateWorkspaceSlug('   ')).toEqual({ ok: false, reason: 'invalid_slug' });
    expect(validateWorkspaceSlug('-abc')).toEqual({ ok: false, reason: 'invalid_slug' });
    expect(validateWorkspaceSlug('abc-')).toEqual({ ok: false, reason: 'invalid_slug' });
  });

  it('rejects too short', () => {
    expect(validateWorkspaceSlug('a')).toEqual({ ok: false, reason: 'slug_too_short' });
  });

  it('rejects too long', () => {
    expect(validateWorkspaceSlug(`a${'b'.repeat(128)}`)).toEqual({
      ok: false,
      reason: 'slug_too_long',
    });
  });
});

describe('slugFromName', () => {
  it('slugifies names', () => {
    expect(slugFromName('My Team')).toBe('my-team');
  });

  it('falls back when empty', () => {
    expect(slugFromName('   ').startsWith('ws-')).toBe(true);
  });
});