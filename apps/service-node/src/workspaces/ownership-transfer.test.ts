import { describe, expect, it } from 'vitest';

import { validateOwnershipTransfer } from './ownership-transfer.ts';

describe('validateOwnershipTransfer', () => {
  it('allows owner to transfer to an admin', () => {
    expect(
      validateOwnershipTransfer({
        actorRole: 'owner',
        targetRole: 'admin',
        actorUserId: 'user-a',
        targetUserId: 'user-b',
      }),
    ).toEqual({ ok: true });
  });

  it('allows owner to transfer to a member', () => {
    expect(
      validateOwnershipTransfer({
        actorRole: 'owner',
        targetRole: 'member',
        actorUserId: 'user-a',
        targetUserId: 'user-b',
      }),
    ).toEqual({ ok: true });
  });

  it('refuses non-owners', () => {
    expect(
      validateOwnershipTransfer({
        actorRole: 'admin',
        targetRole: 'member',
        actorUserId: 'user-a',
        targetUserId: 'user-b',
      }),
    ).toEqual({ ok: false, reason: 'permission_denied' });

    expect(
      validateOwnershipTransfer({
        actorRole: 'member',
        targetRole: 'admin',
        actorUserId: 'user-a',
        targetUserId: 'user-b',
      }),
    ).toEqual({ ok: false, reason: 'permission_denied' });
  });

  it('refuses guest targets', () => {
    expect(
      validateOwnershipTransfer({
        actorRole: 'owner',
        targetRole: 'guest',
        actorUserId: 'user-a',
        targetUserId: 'user-b',
      }),
    ).toEqual({ ok: false, reason: 'invalid_target' });
  });

  it('refuses transferring to an existing owner', () => {
    expect(
      validateOwnershipTransfer({
        actorRole: 'owner',
        targetRole: 'owner',
        actorUserId: 'user-a',
        targetUserId: 'user-b',
      }),
    ).toEqual({ ok: false, reason: 'invalid_target' });
  });

  it('refuses transferring to yourself', () => {
    expect(
      validateOwnershipTransfer({
        actorRole: 'owner',
        targetRole: 'admin',
        actorUserId: 'user-a',
        targetUserId: 'user-a',
      }),
    ).toEqual({ ok: false, reason: 'cannot_transfer_to_self' });
  });
});