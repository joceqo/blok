import type { Readable } from 'node:stream';

export interface BlobStore {
  put(ext: string, content: Buffer, mimeType?: string): Promise<string>;
  deleteByUrl(url: string): Promise<void>;
}

export interface ReadableBlobStore extends BlobStore {
  fileStat(key: string): Promise<{size: number; mtimeMs: number; isDirectory(): boolean}>;
  openReadStream(key: string, range?: {start: number; end: number}): Readable;
}

export function readableStore(store?: BlobStore): ReadableBlobStore | undefined {
  return store && 'fileStat' in store && 'openReadStream' in store ? store as ReadableBlobStore : undefined;
}
