import { describe, expect, it } from 'vitest';

import { canMintTicketForDoc } from './can-mint-ticket-for-doc.js';

describe('canMintTicketForDoc', () => {
  it('refuses when no page is bound to the doc id', () => {
    expect(
      canMintTicketForDoc({
        hasBinding: false,
        role: 'member',
        write: false,
      }),
    ).toEqual({ ok: false, reason: 'doc_not_bound' });
  });

  it('hides the page when the caller is not a workspace member', () => {
    expect(
      canMintTicketForDoc({
        hasBinding: true,
        role: undefined,
        write: false,
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('allows guests to mint read tickets', () => {
    expect(
      canMintTicketForDoc({
        hasBinding: true,
        role: 'guest',
        write: false,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses write tickets for guests', () => {
    expect(
      canMintTicketForDoc({
        hasBinding: true,
        role: 'guest',
        write: true,
      }),
    ).toEqual({ ok: false, reason: 'permission_denied' });
  });

  it('allows members to mint write tickets', () => {
    expect(
      canMintTicketForDoc({
        hasBinding: true,
        role: 'member',
        write: true,
      }),
    ).toEqual({ ok: true });
  });
});