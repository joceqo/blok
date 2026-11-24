import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

function key(secret: string) {
  return Buffer.from(hkdfSync('sha256', secret, 'Blok calendar', 'sealed credentials v1', 32));
}

export function sealCalendarSecret(secret: string, context: string, plaintext: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), nonce);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64');
}

export function openCalendarSecret(secret: string, context: string, value: string) {
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key(secret), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}
