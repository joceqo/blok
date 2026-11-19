import { createHmac } from 'node:crypto';

/** Mirrors `packages/server/src/ticket.ts` — keep in sync with conformance fixtures. */
const MIN_SECRET_LENGTH = 32;
const DEFAULT_TTL_SECONDS = 300;
const HEADER = '{"alg":"HS256","typ":"JWT"}';

export interface BlokTicketClaims {
  user: string;
  doc?: string;
  write?: boolean;
  ttlSeconds?: number;
}

export function blokTicket(secret: string, claims: BlokTicketClaims): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`blokTicket: the secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const payload = {
    user: claims.user,
    ...(claims.doc === undefined ? {} : { doc: claims.doc }),
    write: claims.write ?? false,
    exp: Math.floor(Date.now() / 1000) + (claims.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };

  const signing = `${b64(HEADER)}.${b64(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', secret).update(signing).digest('base64url');

  return `${signing}.${signature}`;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}