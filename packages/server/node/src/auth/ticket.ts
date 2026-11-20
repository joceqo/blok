import { createHmac, timingSafeEqual } from 'node:crypto';

const HEADER_SEGMENT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';

export interface TicketClaims {
  user: string;
  doc: string;
  write: boolean;
  exp: number;
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (value.length % 4 === 1) {
    return undefined;
  }
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (
      !(c >= 0x61 && c <= 0x7a)
      && !(c >= 0x41 && c <= 0x5a)
      && !(c >= 0x30 && c <= 0x39)
      && c !== 0x2d
      && c !== 0x5f
    ) {
      return undefined;
    }
  }
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return undefined;
  }
}

function readPayload(payload: Buffer): TicketClaims | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const claims: TicketClaims = { user: '', doc: '', write: false, exp: 0 };
  for (const [key, value] of Object.entries(record)) {
    switch (key) {
      case 'user':
      case 'doc': {
        if (value === null) {
          break;
        }
        if (typeof value !== 'string') {
          return undefined;
        }
        if (key === 'user') {
          claims.user = value;
        } else {
          claims.doc = value;
        }
        break;
      }
      case 'write':
        if (typeof value !== 'boolean') {
          return undefined;
        }
        claims.write = value;
        break;
      case 'exp': {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          return undefined;
        }
        claims.exp = value;
        break;
      }
      default:
        break;
    }
  }
  return claims;
}

export function verifyTicket(secret: string, token: string, nowMs: number): { claims: TicketClaims; ok: true } | { ok: false } {
  if (secret === '') {
    return { ok: false };
  }
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    return { ok: false };
  }
  const signature = decodeBase64Url(segments[2]);
  if (segments[0] !== HEADER_SEGMENT || signature === undefined) {
    return { ok: false };
  }
  const mac = createHmac('sha256', secret).update(`${segments[0]}.${segments[1]}`).digest();
  if (signature.length !== mac.length || !timingSafeEqual(signature, mac)) {
    return { ok: false };
  }
  const payload = decodeBase64Url(segments[1]);
  if (payload === undefined) {
    return { ok: false };
  }
  const claims = readPayload(payload);
  if (claims === undefined || claims.exp <= Math.floor(nowMs / 1000)) {
    return { ok: false };
  }
  return { claims, ok: true };
}