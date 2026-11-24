import { blokTicket } from '../tickets/hmac.ts';

/**
 * Mints a read-only sidecar pass for GET document state when the browser has a session but no Authorization header.
 */
export function mintDocumentStateAuthorization(userId: string, docId: string): string | undefined {
  const secret = process.env.BLOK_SECRET;
  if (secret === undefined || secret.length === 0) {
    return undefined;
  }
  try {
    const ticket = blokTicket(secret, {
      user: userId,
      doc: docId,
      write: false,
    });
    return `Bearer ${ticket}`;
  } catch {
    return undefined;
  }
}