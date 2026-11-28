import { createHmac, timingSafeEqual } from 'node:crypto';

/** Must match BlokTicket.MinimumSecretLength (C#) and packages/server/src/ticket.ts. */
const MIN_SECRET_LENGTH = 32;
const DEFAULT_TTL_SECONDS = 300;

const HEADER = '{"alg":"HS256","typ":"JWT"}';
const HEADER_B64 = Buffer.from(HEADER, 'utf-8').toString('base64url');

export interface BlokTicketClaims {
  user: string;
  doc?: string;
  write?: boolean;
  ttlSeconds?: number;
}

export interface VerifiedBlokTicket {
  user: string;
  doc?: string;
  write: boolean;
  exp: number;
}

/**
 * Mints an HS256 collaboration pass — byte-compatible with packages/server `blokTicket`.
 */
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

  const signing = `${HEADER_B64}.${b64(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', secret).update(signing).digest('base64url');

  return `${signing}.${signature}`;
}

/**
 * Verifies signature and header; returns parsed claims or throws.
 */
export function authenticatedTicketPayload(secret: string, token: string): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`verifyBlokTicket: the secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('verifyBlokTicket: malformed token');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  if (headerB64 === undefined || payloadB64 === undefined || signatureB64 === undefined) {
    throw new Error('verifyBlokTicket: malformed token');
  }

  if (headerB64 !== HEADER_B64) {
    throw new Error('verifyBlokTicket: non-canonical header');
  }

  const isSegment = (part: string) => part.length > 0 && part.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(part);
  if (!isSegment(payloadB64) || !isSegment(signatureB64)) throw new Error('verifyBlokTicket: malformed token');
  const signing = `${headerB64}.${payloadB64}`;
  const expected = createHmac('sha256', secret).update(signing).digest();
  const supplied = Buffer.from(signatureB64, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('verifyBlokTicket: invalid signature');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payloadB64, 'base64url'));
}

export function verifyBlokTicket(secret: string, token: string): VerifiedBlokTicket {
  const payload = JSON.parse(authenticatedTicketPayload(secret, token)) as {
    user?: unknown;
    doc?: unknown;
    write?: unknown;
    exp?: unknown;
  };

  if (typeof payload.user !== 'string' || payload.user.length === 0) {
    throw new Error('verifyBlokTicket: missing user');
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new Error('verifyBlokTicket: missing exp');
  }

  const result: VerifiedBlokTicket = {
    user: payload.user,
    write: payload.write === true,
    exp: payload.exp,
  };
  if (typeof payload.doc === 'string') {
    result.doc = payload.doc;
  }
  return result;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}