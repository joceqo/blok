import { describe, expect, it } from 'vitest';

import { canPurgeTrashedPage } from './can-purge-trashed-page.js';

describe('canPurgeTrashedPage', () => {
  it('allows workspace owners to purge a trashed page', () => {
    expect(
      canPurgeTrashedPage({
        actorRole: 'owner',
        trashed: true,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses non-owners', () => {
    expect(
      canPurgeTrashedPage({
        actorRole: 'admin',
        trashed: true,
      }),
    ).toEqual({ ok: false, reason: 'permission_denied' });

    expect(
      canPurgeTrashedPage({
        actorRole: 'member',
        trashed: true,
      }),
    ).toEqual({ ok: false, reason: 'permission_denied' });
  });

  it('refuses when the page is not in trash', () => {
    expect(
      canPurgeTrashedPage({
        actorRole: 'owner',
        trashed: false,
      }),
    ).toEqual({ ok: false, reason: 'not_trashed' });
  });
});