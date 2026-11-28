import { describe, expect, it } from 'vitest';

import { inviteEmailMatchesUser, validateInviteAccept } from './invite-accept.ts';

describe('inviteEmailMatchesUser', () => {
  it('matches after normalization', () => {
    expect(inviteEmailMatchesUser('User@Example.com', 'user@example.com')).toBe(true);
  });

  it('rejects different addresses', () => {
    expect(inviteEmailMatchesUser('a@example.com', 'b@example.com')).toBe(false);
  });
});

describe('validateInviteAccept', () => {
  const pending = { acceptedAt: null, email: 'invitee@example.com' };

  it('allows a pending invite for the same email', () => {
    expect(validateInviteAccept(pending, 'invitee@example.com')).toEqual({ ok: true });
  });

  it('blocks already accepted invites', () => {
    expect(
      validateInviteAccept(
        { acceptedAt: new Date('2026-01-01'), email: 'invitee@example.com' },
        'invitee@example.com',
      ),
    ).toEqual({ ok: false, reason: 'already_accepted' });
  });

  it('blocks when session email does not match invite', () => {
    expect(validateInviteAccept(pending, 'other@example.com')).toEqual({
      ok: false,
      reason: 'email_mismatch',
    });
  });
});