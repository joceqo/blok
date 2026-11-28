import { randomBytes } from 'node:crypto';

const HEX_LENGTH = 32;
const MAX_EXTENSION_LENGTH = 15;

export const ErrForeign = new Error('blob: the URL was not issued by this store');

export function normalizeExtension(extension: string): string {
  if (extension.length < 2 || extension.length > MAX_EXTENSION_LENGTH + 1 || extension[0] !== '.') {
    return '';
  }
  for (let i = 1; i < extension.length; i += 1) {
    const c = extension.charCodeAt(i);
    if (
      !((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))
    ) {
      return '';
    }
  }
  return extension.toLowerCase();
}

export function newKey(extension: string): string {
  return randomBytes(HEX_LENGTH / 2).toString('hex') + normalizeExtension(extension);
}

export function isGenerated(key: string): boolean {
  if (key.length < HEX_LENGTH) {
    return false;
  }
  for (let i = 0; i < HEX_LENGTH; i += 1) {
    const c = key.charCodeAt(i);
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) {
      return false;
    }
  }
  const extension = key.slice(HEX_LENGTH);
  return extension === '' || extension === normalizeExtension(extension);
}

export function keyFromPublicUrl(publicUrl: string, rawUrl: string): string | undefined {
  const cut = rawUrl.search(/[?#]/);
  const trimmed = cut >= 0 ? rawUrl.slice(0, cut) : rawUrl;
  const prefix = `${publicUrl.replace(/\/+$/, '')}/`;
  if (!trimmed.startsWith(prefix)) {
    return undefined;
  }
  const key = trimmed.slice(prefix.length);
  return isGenerated(key) ? key : undefined;
}

export function extension(name: string): string {
  for (let i = name.length - 1; i >= 0; i -= 1) {
    const c = name[i];
    if (c === '.') {
      if (i === name.length - 1) {
        return '';
      }
      return name.slice(i);
    }
    if (c === '/' || c === '\\') {
      return '';
    }
  }
  return '';
}