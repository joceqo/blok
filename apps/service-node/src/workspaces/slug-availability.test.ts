import { describe, expect, it } from 'vitest';

import { resolveWorkspaceSlugAvailability } from './slug-availability.ts';
import { validateWorkspaceSlug } from './slug.ts';

describe('resolveWorkspaceSlugAvailability', () => {
  it('reports available when slug is valid and unused', () => {
    const validation = validateWorkspaceSlug('my-team');
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      throw new Error('fixture');
    }
    expect(resolveWorkspaceSlugAvailability(validation, false)).toEqual({
      status: 'ok',
      available: true,
    });
  });

  it('reports unavailable when slug is valid but taken', () => {
    const validation = validateWorkspaceSlug('my-team');
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      throw new Error('fixture');
    }
    expect(resolveWorkspaceSlugAvailability(validation, true)).toEqual({
      status: 'ok',
      available: false,
    });
  });

  it('returns invalid without considering taken state', () => {
    expect(resolveWorkspaceSlugAvailability(validateWorkspaceSlug('A'), true)).toEqual({
      status: 'invalid',
      reason: 'invalid_slug',
    });
    expect(resolveWorkspaceSlugAvailability(validateWorkspaceSlug('a'), false)).toEqual({
      status: 'invalid',
      reason: 'slug_too_short',
    });
  });
});