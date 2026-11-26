import { createHmac, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { resolveEnvironmentProxy } from './environment-proxy.ts';
import { requestThroughProxy } from './s3-proxy-request.ts';
import { absoluteUri } from '../dotnet/absolute-uri.ts';
import { sanitizeWire } from '../mediatype/index.ts';
import { ErrForeign, keyFromPublicUrl, newKey, normalizeExtension } from './key.ts';
import type { BlobStore, ReadableBlobStore } from './store.ts';
import { LocalStore } from './local.ts';

const EMPTY_HASH = createHash('sha256').update('').digest('hex');
const ERROR_BODY_LIMIT = 512;

export interface S3StoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  publicUrl: string;
  addressing: string;
  now?: () => Date;
}

interface S3Target {
  readonly url: string;
  readonly host: string;
  readonly path: string;
}

function dnsCompatibleBucket(bucket: string): boolean {
  if (bucket.length < 3 || bucket.length > 63) {
    return false;
  }
  for (let i = 0; i < bucket.length; i += 1) {
    const c = bucket[i]!;
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      continue;
    }
    if (c === '.' && i > 0 && i < bucket.length - 1 && bucket[i - 1] !== '.') {
      continue;
    }
    if (c !== '-' || i === 0 || i === bucket.length - 1 || bucket[i - 1] === '.' || bucket[i + 1] === '.') {
      return false;
    }
  }
  return true;
}

function usesVirtualHosted(addressing: string, endpointHost: string, bucket: string): boolean {
  if (addressing === 'path') {
    return false;
  }
  if (addressing === 'virtual') {
    return true;
  }
  const lower = endpointHost.toLowerCase();
  return (lower === 'amazonaws.com' || lower.endsWith('.amazonaws.com'))
    && !bucket.includes('.')
    && dnsCompatibleBucket(bucket);
}

function defaultPort(protocol: string, port: string): boolean {
  if (port === '') {
    return true;
  }
  if (protocol === 'http:' && port === '80') {
    return true;
  }
  return protocol === 'https:' && port === '443';
}

function sanitizeS3MediaType(value: string): string {
  const trimmed = value.trim();
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return '';
    }
  }
  return sanitizeWire(trimmed);
}

function requireKey(key: string): void {
  if (key === '') {
    throw new Error('blobstore: s3 key is empty');
  }
}

function escapeKeyInPath(key: string): string {
  return key.replace(/\?/g, '%3F').replace(/#/g, '%23');
}

function resolveTarget(options: S3StoreOptions, key: string): S3Target {
  const endpoint = new URL(options.endpoint);
  const safeKey = escapeKeyInPath(key);
  const virtual = usesVirtualHosted(options.addressing, endpoint.hostname, options.bucket);
  const hostName = virtual ? `${options.bucket}.${endpoint.hostname}` : endpoint.hostname;
  const objectPath = virtual ? `/${safeKey}` : `/${options.bucket}/${safeKey}`;
  const authority = defaultPort(endpoint.protocol, endpoint.port)
    ? hostName
    : `${hostName}${endpoint.port ? `:${endpoint.port}` : ''}`;
  const url = absoluteUri(`${endpoint.protocol}//${authority}${objectPath}`);
  const parsed = new URL(url);
  return { url, host: authority, path: parsed.pathname };
}

function canonicalHeaderValue(value: string): string {
  return value.split(/\s+/).filter((part) => part !== '').join(' ');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function sign(
  method: string,
  path: string,
  host: string,
  region: string,
  accessKey: string,
  secretKey: string,
  contentType: string,
  payloadHash: string,
  at: Date,
): Record<string, string> {
  const utc = at;
  const pad = (value: number): string => String(value).padStart(2, '0');
  const amzDate = `${utc.getUTCFullYear()}${pad(utc.getUTCMonth() + 1)}${pad(utc.getUTCDate())}T${pad(utc.getUTCHours())}${pad(utc.getUTCMinutes())}${pad(utc.getUTCSeconds())}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const headers: Array<{ name: string; value: string }> = [];
  if (contentType !== '') {
    headers.push({ name: 'content-type', value: contentType });
  }
  headers.push(
    { name: 'host', value: host },
    { name: 'x-amz-content-sha256', value: payloadHash },
    { name: 'x-amz-date', value: amzDate },
  );
  let canonical = '';
  const signedNames: string[] = [];
  for (const header of headers) {
    canonical += `${header.name}:${canonicalHeaderValue(header.value)}\n`;
    signedNames.push(header.name);
  }
  const signed = signedNames.join(';');
  const canonicalRequest = [method, path, '', canonical, signed, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const requestHash = createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, requestHash].join('\n');
  let signingKey = hmacSha256(`AWS4${secretKey}`, dateStamp);
  signingKey = hmacSha256(signingKey, region);
  signingKey = hmacSha256(signingKey, 's3');
  signingKey = hmacSha256(signingKey, 'aws4_request');
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  const out: Record<string, string> = {
    Authorization: authorization,
    Host: host,
    'X-Amz-Content-Sha256': payloadHash,
    'X-Amz-Date': amzDate,
  };
  if (contentType !== '') {
    out['Content-Type'] = contentType;
  }
  return out;
}

function rawRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<{ status: number; body: Buffer }> {
  const proxy = resolveEnvironmentProxy(url);
  if (proxy !== undefined) {
    return requestThroughProxy(url, method, headers, body, proxy);
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port === '' ? undefined : parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          ...headers,
          'User-Agent': '',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined && body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}

export class S3Store implements BlobStore {
  private readonly now: () => Date;

  constructor(readonly options: S3StoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async put(ext: string, content: Buffer, mimeType = ''): Promise<string> {
    const key = newKey(normalizeExtension(ext));
    const wireMime = sanitizeS3MediaType(mimeType);
    const hash = createHash('sha256').update(content).digest('hex');
    await this.send('PUT', key, wireMime, content, hash);
    return `${this.options.publicUrl.replace(/\/+$/, '')}/${key}`;
  }

  async deleteByUrl(url: string): Promise<void> {
    const key = keyFromPublicUrl(this.options.publicUrl, url);
    if (key === undefined) {
      throw ErrForeign;
    }
    await this.send('DELETE', key, '', Buffer.alloc(0), EMPTY_HASH);
  }

  /**
   * Reads one raw key, for the collab working set. A 404 answers nothing; a
   * 403 stays a failure, because S3 answers 403 for a missing key whenever the
   * credentials may not list the bucket.
   */
  async getObject(key: string): Promise<Buffer | undefined> {
    requireKey(key);
    return this.send('GET', key, '', Buffer.alloc(0), EMPTY_HASH, true);
  }

  async putObject(key: string, content: Buffer): Promise<void> {
    requireKey(key);
    const hash = createHash('sha256').update(content).digest('hex');
    await this.send('PUT', key, 'application/octet-stream', content, hash);
  }

  async deleteObject(key: string): Promise<void> {
    requireKey(key);
    await this.send('DELETE', key, '', Buffer.alloc(0), EMPTY_HASH, true);
  }

  private async send(
    method: string,
    key: string,
    mimeType: string,
    body: Buffer,
    hash: string,
    allowNotFound = false,
  ): Promise<Buffer | undefined> {
    const target = resolveTarget(this.options, key);
    const headers = sign(
      method,
      target.path,
      target.host,
      this.options.region,
      this.options.accessKey,
      this.options.secretKey,
      mimeType,
      hash,
      this.now(),
    );
    if (method === 'PUT') {
      headers['Content-Disposition'] = 'attachment';
      headers['Content-Length'] = String(body.length);
    } else if (body.length === 0) {
      headers['Content-Length'] = '0';
    }
    const response = await rawRequest(target.url, method, headers, method === 'PUT' ? body : undefined);
    if (response.status >= 200 && response.status <= 299) {
      return response.body;
    }
    if (allowNotFound && response.status === 404) {
      return undefined;
    }
    const detail = response.body.subarray(0, ERROR_BODY_LIMIT).toString('utf8').trim();
    throw new Error(`blobstore: s3 ${method} returned ${response.status}: ${detail}`);
  }
}

// The hosted service exposes only its authorized /files URL. Old workspaces
// may have files on disk, with the exact same URL format as new S3 objects.
export class PrivateS3Store extends S3Store implements ReadableBlobStore {
  constructor(options: S3StoreOptions, private readonly legacy?: LocalStore) {
    super(options);
  }

  private async legacyFile(key: string) {
    try {
      return await this.legacy?.fileStat(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async read(method: 'HEAD' | 'GET', key: string, range?: {start:number; end:number}) {
    const target = resolveTarget(this.options, key);
    const headers = sign(method, target.path, target.host, this.options.region,
      this.options.accessKey, this.options.secretKey, '', EMPTY_HASH, new Date());
    if (range) headers.Range = `bytes=${range.start}-${range.end}`;
    const response = await fetch(target.url, {method, headers, redirect:'error', signal:AbortSignal.timeout(60_000)});
    if (response.status !== (range ? 206 : 200)) {
      await response.body?.cancel();
      throw Object.assign(new Error('Private object read failed'), { code: response.status === 404 ? 'ENOENT' : 'EIO' });
    }
    return response;
  }

  async checkBucket(): Promise<void> {
    await this.read('HEAD', '');
  }

  async fileStat(key: string) {
    const disk = await this.legacyFile(key);
    if (disk) return disk;
    const response = await this.read('HEAD', key);
    const size = Number(response.headers.get('content-length'));
    const mtimeMs = Date.parse(response.headers.get('last-modified') ?? '');
    if (!response.headers.has('content-length') || !Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtimeMs))
      throw new Error('Invalid private object metadata');
    return { size, mtimeMs, isDirectory: () => false };
  }

  openReadStream(key: string, range?: {start:number; end:number}): Readable {
    return Readable.from(this.bytes(key, range));
  }

  private async *bytes(key: string, range?: {start:number; end:number}) {
    if (this.legacy && await this.legacyFile(key)) {
      yield* this.legacy.openReadStream(key, range);
      return;
    }
    const response = await this.read('GET', key, range);
    if (!response.body) throw new Error('Missing private object body');
    for await (const bytes of response.body) yield Buffer.from(bytes);
  }

  override async deleteByUrl(url: string): Promise<void> {
    const key = keyFromPublicUrl(this.options.publicUrl, url);
    if (key === undefined) throw ErrForeign;
    if (this.legacy && await this.legacyFile(key)) {
      await this.legacy.deleteByUrl(url);
      return;
    }
    await super.deleteByUrl(url);
  }
}
