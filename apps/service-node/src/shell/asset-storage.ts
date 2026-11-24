import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blokTicket } from '../tickets/hmac.ts';

export const mediaOrigin = 'http://127.0.0.1:18103';
const generatedKey = /^[0-9a-f]{32}(?:\.[a-z0-9]{1,15})?$/;
export const uploadDirectory = () => join(process.env.DATA_DIRECTORY ?? './data', 'uploads');

export function assetKey(raw: string, publicURL: string) {
  try {
    const base = new URL(publicURL);
    const url = new URL(raw, base);
    const name = url.pathname.slice('/files/'.length);
    if (url.origin === base.origin && url.pathname.startsWith('/files/') && generatedKey.test(name)) return name;
  } catch { /* Malformed reference. */ }
}

export function isAssetKey(key: string): boolean { return generatedKey.test(key); }

async function mediaWrite(host: string, action: string, body: FormData | string) {
  const origin = new URL(process.env.PUBLIC_URL || 'http://localhost:8080').origin;
  const ticket = blokTicket(process.env.TICKET_SECRET ?? '', {user:'workspace-storage',write:true,ttlSeconds:60});
  const headers = new Headers({Origin:origin, Authorization:'Bearer '+ticket});
  if (typeof body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(host + action, {method:'POST', body, headers, redirect:'error', signal:AbortSignal.timeout(60_000)});
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Private media service could not store or remove the asset');
  }
  return response;
}

export async function writeImage(bytes: Buffer, extension: string, host = mediaOrigin) {
  if (process.env.BLOK_S3_BUCKET) {
    const form = new FormData();
    const type = 'image/' + (extension === 'jpg' ? 'jpeg' : extension);
    form.set('file', new Blob([new Uint8Array(bytes)], { type }), 'image.' + extension);
    const data = await (await mediaWrite(host, '/upload', form)).json();
    const name = assetKey(data.url, process.env.PUBLIC_URL || 'http://localhost:8080');
    if (!name) throw new Error('Invalid private upload response');
    return name;
  }
  const name = randomBytes(16).toString('hex') + '.' + extension;
  await mkdir(uploadDirectory(), {recursive:true,mode:0o700});
  await writeFile(join(uploadDirectory(), name), bytes, {flag:'wx',mode:0o600});
  return name;
}

export async function removeAssetFile(name: string, host = mediaOrigin) {
  if (!isAssetKey(name)) throw new Error('Invalid stored asset name');
  if (process.env.BLOK_S3_BUCKET) {
    const url = new URL('/files/' + name, process.env.PUBLIC_URL || 'http://localhost:8080').href;
    const response = await mediaWrite(host, '/delete', JSON.stringify({url}));
    await response.body?.cancel();
  } else {
    await rm(join(uploadDirectory(), name), { force: true });
  }
}
