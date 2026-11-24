import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const prefix = 'scrypt$32768$8$3$';
const encodedDigest = /^([a-f0-9]{32})\$([a-f0-9]{64})$/;
const dummySalt = randomBytes(16);
const dummyKey = randomBytes(32);

export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 1024 && [...value].length >= 12;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) throw new Error('Le mot de passe doit contenir au moins 12 caractères et au plus 1 024 octets.');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return prefix + salt.toString('hex') + '$' + key.toString('hex');
}

export async function verifyPassword(password: string, stored?: string | null): Promise<boolean> {
  const match = stored?.startsWith(prefix) && encodedDigest.exec(stored.slice(prefix.length));
  const salt = match ? Buffer.from(match[1]!, 'hex') : dummySalt;
  const expected = match ? Buffer.from(match[2]!, 'hex') : dummyKey;
  const actual = await derive(password, salt);
  return timingSafeEqual(expected, actual) && !!match;
}
