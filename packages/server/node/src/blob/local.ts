import { createReadStream, type ReadStream } from 'node:fs';
import { link, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ErrForeign, extension, keyFromPublicUrl, newKey } from './key.ts';
import type { BlobStore } from './store.ts';

export class LocalStore implements BlobStore {
  constructor(
    readonly directory: string,
    readonly publicUrl: string,
  ) {}

  async put(ext: string, content: Buffer, _mimeType?: string): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o777 });
    const key = newKey(ext);
    const finalPath = join(this.directory, key);
    const tempPath = join(this.directory, `.blok-upload-${randomBytes(16).toString('hex')}`);
    await writeFile(tempPath, content, { mode: 0o600 });
    try {
      await link(tempPath, finalPath);
      await rm(tempPath, { force: true });
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        await rm(tempPath, { force: true });
        throw error;
      }
      try {
        await stat(finalPath);
        await rm(tempPath, { force: true });
        throw error;
      } catch {
        await rename(tempPath, finalPath);
      }
    }
    return `${this.publicUrl.replace(/\/+$/, '')}/${key}`;
  }

  openReadStream(key: string, range?: { start: number; end: number }): ReadStream {
    return createReadStream(join(this.directory, key), range);
  }

  async fileStat(key: string) {
    return stat(join(this.directory, key));
  }

  async deleteByUrl(url: string): Promise<void> {
    const key = keyFromPublicUrl(this.publicUrl, url);
    if (key === undefined) {
      throw ErrForeign;
    }
    const path = join(this.directory, key);
    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory()) {
      throw new Error('is a directory');
    }
    await rm(path, { force: true });
    try {
      await stat(this.directory);
    } catch {
      throw new Error('directory missing');
    }
  }
}

export function contentTypeFor(name: string): string {
  const ext = extension(name).toLowerCase();
  if (ext === '.txt') {
    return 'text/plain';
  }
  if (ext === '.json') {
    return 'application/json';
  }
  if (ext === '.pdf') {
    return 'application/pdf';
  }
  return 'application/octet-stream';
}