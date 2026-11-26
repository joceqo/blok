import { createReadStream, type ReadStream } from 'node:fs';
import { link, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CONTENT_TYPES } from './content-types.ts';
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

/**
 * CONTENT_TYPES by lower-case key: the generated table keeps ASP.NET's own
 * spelling, which has upper-case keys (".IVF"), while a stored key is lower
 * case. Built once, as the Go host builds its `lowerContentTypes`.
 */
const LOWER_CONTENT_TYPES: ReadonlyMap<string, string> = new Map(
  Object.entries(CONTENT_TYPES).map(([ext, type]) => [ext.toLowerCase(), type]),
);

/** What FileExtensionContentTypeProvider answers, else a byte stream. */
export function contentTypeFor(name: string): string {
  return LOWER_CONTENT_TYPES.get(extension(name).toLowerCase()) ?? 'application/octet-stream';
}