import { normalizeEmail } from '@/auth/codes.js';

export type InviteAcceptBlockReason = 'already_accepted' | 'email_mismatch';

export interface PendingInvite {
  acceptedAt: Date | null;
  email: string;
}

export function inviteEmailMatchesUser(inviteEmail: string, userEmail: string): boolean {
  return normalizeEmail(inviteEmail) === normalizeEmail(userEmail);
}

export function validateInviteAccept(
  invite: PendingInvite,
  sessionUserEmail: string,
): { ok: true } | { ok: false; reason: InviteAcceptBlockReason } {
  if (invite.acceptedAt !== null) {
    return { ok: false, reason: 'already_accepted' };
  }
  if (!inviteEmailMatchesUser(invite.email, sessionUserEmail)) {
    return { ok: false, reason: 'email_mismatch' };
  }
  return { ok: true };
}