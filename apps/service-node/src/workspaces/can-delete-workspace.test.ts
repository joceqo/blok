import { describe, expect, it } from 'vitest';

import { canDeleteWorkspace } from '@/workspaces/can-delete-workspace.js';

describe('canDeleteWorkspace', () => {
  it('allows owner to delete when workspace has no pages', () => {
    expect(
      canDeleteWorkspace({
        actorRole: 'owner',
        pageCount: 0,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses non-owners', () => {
    expect(
      canDeleteWorkspace({
        actorRole: 'admin',
        pageCount: 0,
      }),
    ).toEqual({ ok: false, reason: 'permission_denied' });

    expect(
      canDeleteWorkspace({
        actorRole: 'member',
        pageCount: 0,
      }),
    ).toEqual({ ok: false, reason: 'permission_denied' });
  });

  it('refuses when pages exist', () => {
    expect(
      canDeleteWorkspace({
        actorRole: 'owner',
        pageCount: 1,
      }),
    ).toEqual({ ok: false, reason: 'has_content' });

    expect(
      canDeleteWorkspace({
        actorRole: 'owner',
        pageCount: 42,
      }),
    ).toEqual({ ok: false, reason: 'has_content' });
  });
});