export interface BlobStore {
  put(ext: string, content: Buffer, mimeType?: string): Promise<string>;
  deleteByUrl(url: string): Promise<void>;
}