import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { PgPool } from '../db/pool.ts';

export async function loadAiKey(pool: Pick<PgPool, 'query'>, directory: string, encoded?: string) {
  if (encoded) {
    const value = Buffer.from(encoded, 'base64');
    if (value.length !== 32 || value.toString('base64') !== encoded) throw new Error('Invalid AI_ENCRYPTION_KEY');
    return value;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, 'ai-key');
  const read = async () => {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== 32) throw new Error('Invalid persisted AI key');
      return await file.readFile();
    } finally { await file.close(); }
  };
  try { return await read(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const {rows} = await pool.query('SELECT EXISTS(SELECT FROM ai_credentials WHERE encrypted_key IS NOT NULL) AS configured');
  if (rows[0].configured) return read(); // A restored database needs its original key.
  const temp = join(directory, '.ai-key-' + randomUUID());
  const file = await open(temp, 'wx', 0o600);
  try {
    try { await file.writeFile(randomBytes(32)); await file.sync(); } finally { await file.close(); }
    try { await link(temp, target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    return await read();
  } finally { await unlink(temp); }
}

export function sealAiKey(key: Buffer, owner: string, secret: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('blok:openai:v1:' + owner));
  return Buffer.concat([nonce, cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]);
}

export function openAiKey(key: Buffer, owner: string, value: Buffer) {
  const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  cipher.setAAD(Buffer.from('blok:openai:v1:' + owner));
  cipher.setAuthTag(value.subarray(-16));
  return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8');
}
