// One object per document at {prefix}/{doc key}, through the raw-key half of
// the S3 blob store (C# S3CollabStore.cs, Go workingset/s3.go).
import { S3Store } from '../../blob/s3.ts';
import type { BlobStore } from '../../blob/store.ts';
import {
  decodeOrAbsent,
  docKey,
  encodeDocument,
  ensureResetRaisesEpoch,
  type Tag,
  type WorkingSet,
} from './working-set.ts';

/** The raw-key half of blob/s3.ts. A missing key reads as nothing and deletes as done. */
export interface ObjectStore {
  getObject(key: string): Promise<Buffer | undefined>;
  putObject(key: string, content: Buffer): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

export class S3WorkingSetStore {
  private readonly prefix: string;

  constructor(
    private readonly objects: ObjectStore,
    prefix: string,
    private readonly log?: (message: string) => void,
  ) {
    this.prefix = prefix.replace(/^\/+|\/+$/g, '');
    if (this.prefix === '') throw new Error("collab: the S3 prefix must not be empty. (Parameter 'prefix')");
  }

  private keyFor(docId: string): string {
    return `${this.prefix}/${docKey(docId)}`;
  }

  async read(docId: string): Promise<WorkingSet | undefined> {
    const document = await this.objects.getObject(this.keyFor(docId));
    return document === undefined ? undefined : decodeOrAbsent(docId, document, this.log);
  }

  /**
   * No guard read: the room owns the epoch law, a write happens per edit, and
   * S3 cannot read a header cheaply the way the local driver can — so a GET
   * before every PUT would double an edit's traffic and latency.
   */
  async write(docId: string, updates: Buffer, tag: Tag): Promise<void> {
    await this.objects.putObject(this.keyFor(docId), encodeDocument(tag, updates));
  }

  /** A reset is an operator lever, so it can afford the guard read a write cannot. */
  async reset(docId: string, tag: Tag): Promise<void> {
    const document = encodeDocument(tag, Buffer.alloc(0));
    ensureResetRaisesEpoch(docId, await this.read(docId), tag);
    await this.objects.putObject(this.keyFor(docId), document);
  }

  /** A corrupt object is never moved aside: it may be the only copy left to repair from. */
  async retire(docId: string): Promise<void> {
    const key = this.keyFor(docId);
    const document = await this.objects.getObject(key);
    if (document !== undefined && decodeOrAbsent(docId, document, this.log) !== undefined) {
      await this.objects.deleteObject(key);
    }
  }

  async delete(docId: string): Promise<void> {
    await this.objects.deleteObject(this.keyFor(docId));
  }
}

/**
 * The store a host builds from its own blob store, or nothing when no prefix
 * was given. A prefix without a bucket is refused rather than ignored: the
 * room would accept every edit and persist none of them.
 */
export function s3WorkingSets(
  store: BlobStore | undefined,
  prefix: string,
  log?: (message: string) => void,
): S3WorkingSetStore | undefined {
  if (prefix === '') return undefined;
  if (!(store instanceof S3Store)) throw new Error('collab: an S3 working set needs an S3 bucket');
  return new S3WorkingSetStore(store, prefix, log);
}
