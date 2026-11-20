import { csQuote } from './numbers.ts';
import type { ParsedHostArgs } from './parse.ts';
import { bindScope, isLoopbackListen, originIsLoopback } from './listen-bind.ts';
import { validatePublicUrl, validateRateLimit } from './public-url.ts';
import { defaultMaxUpload } from '../host/upload.ts';

const MINIMUM_SECRET_LENGTH = 32;
const MAX_REMOTE_UPLOAD = 0x7fffffc7;
const DEFAULT_FILE_BYTES_MAX = 100 << 20;

function quote(value: string): string {
  return csQuote(value);
}

function defaultFileBytesMax(fromFlag: number | undefined): number {
  return fromFlag ?? DEFAULT_FILE_BYTES_MAX;
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '') {
      return undefined;
    }
    if (url.search !== '' || url.hash !== '') {
      return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    if (url.hostname === '') {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function parseHttpOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '') {
      return undefined;
    }
    if (url.search !== '' || url.hash !== '') {
      return undefined;
    }
    if (url.pathname !== '' && url.pathname !== '/') {
      return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    if (url.hostname === '') {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function hasStorage(parsed: ParsedHostArgs): boolean {
  return parsed.storageDirectory !== '' || parsed.s3Bucket !== '';
}

function validateCollabWhenDisabled(parsed: ParsedHostArgs): string | undefined {
  if (parsed.collabEnabled) {
    return undefined;
  }
  if (parsed.docEndpoint !== '') {
    return '--doc-endpoint needs --collab: without it no sync room ever runs and the endpoint would be silently ignored';
  }
  if (parsed.collabS3Prefix !== '') {
    return '--collab-s3-prefix needs --collab: without it no working set is ever written and the prefix would be silently ignored';
  }
  if (parsed.collabJournal) {
    return '--collab-journal needs --collab: without it no sync room ever runs and the journal would be silently ignored';
  }
  return undefined;
}

function validateS3(parsed: ParsedHostArgs): string | undefined {
  if (parsed.s3Bucket === '') {
    return undefined;
  }
  if (parsed.s3Endpoint === '') {
    return '--s3-bucket needs --s3-endpoint, e.g. https://s3.eu-central-1.amazonaws.com';
  }
  const endpoint = parseHttpUrl(parsed.s3Endpoint);
  if (endpoint === undefined) {
    return `--s3-endpoint must be a full HTTP(S) origin without credentials, a path, a query or a fragment (got ${quote(parsed.s3Endpoint)})`;
  }
  if (endpoint.pathname !== '' && endpoint.pathname !== '/') {
    return `--s3-endpoint must be a full HTTP(S) origin without credentials, a path, a query or a fragment (got ${quote(parsed.s3Endpoint)})`;
  }
  if (endpoint.protocol === 'http:' && !originIsLoopback(parsed.s3Endpoint)) {
    return `--s3-endpoint must use HTTPS unless it targets loopback for local development (got ${quote(parsed.s3Endpoint)})`;
  }
  if (parsed.s3Region === '') {
    return '--s3-bucket needs --s3-region: an empty region is signed into every request and fails only at the first upload';
  }
  if (parsed.s3BucketUrl === '') {
    return '--s3-bucket needs --s3-bucket-url: it is the prefix stored URLs are built from, and the only prefix a delete is recognised under';
  }
  if (parsed.s3BucketUrl.includes('?') || parsed.s3BucketUrl.includes('#')) {
    return `--s3-bucket-url must not contain a query or fragment (got ${quote(parsed.s3BucketUrl)})`;
  }
  if (parseHttpUrl(parsed.s3BucketUrl) === undefined) {
    return `--s3-bucket-url must be a full HTTP(S) URL (got ${quote(parsed.s3BucketUrl)})`;
  }
  if (parsed.s3AccessKey === '' || parsed.s3SecretKey === '') {
    return '--s3-bucket needs credentials in the BLOK_S3_ACCESS_KEY and BLOK_S3_SECRET_KEY environment variables (they are deliberately not flags: a flag lands in this machine\'s process list)';
  }
  if (parsed.s3Addressing !== '' && parsed.s3Addressing !== 'path' && parsed.s3Addressing !== 'virtual') {
    return `--s3-addressing must be "path" or "virtual", or empty to choose automatically (got ${quote(parsed.s3Addressing)})`;
  }
  return undefined;
}

/** Startup validation mirrored from BlokServerOptions.Validate. */
export function validateHostStartup(parsed: ParsedHostArgs): string | undefined {
  const auth = parsed.auth;
  const listen = parsed.listen;

  if (auth === 'none' && !isLoopbackListen(listen)) {
    return `--auth none serves anyone who can reach ${quote(listen)}${bindScope(listen)}; it may only bind loopback — use --listen 127.0.0.1:PORT, or --auth ticket to expose this service`;
  }
  if (auth === 'proxy' && !isLoopbackListen(listen)) {
    return `--auth proxy trusts every caller, so it may only bind loopback, not ${quote(listen)}${bindScope(listen)} — use --listen 127.0.0.1:PORT, or --auth ticket to expose this service`;
  }
  if (auth === 'ticket' && parsed.secret.length < MINIMUM_SECRET_LENGTH) {
    return `--secret must be at least ${MINIMUM_SECRET_LENGTH} characters (got ${parsed.secret.length})`;
  }
  if (auth === 'ticket' && parsed.allowedOrigins.length === 0) {
    return 'a public service needs --allow-origin: without it anyone who finds this address can drive requests at third-party sites from your IP';
  }
  if (auth !== 'none' && auth !== 'proxy' && auth !== 'ticket') {
    return `--auth must be none, proxy, or ticket (got ${quote(auth)})`;
  }

  const rateLimitErr = validateRateLimit(parsed.rateLimitPerMinute);
  if (rateLimitErr !== undefined) {
    return rateLimitErr;
  }

  const maxUpload = defaultMaxUpload(parsed.maxUploadBytes);
  if (maxUpload <= 0) {
    return `--max-upload must be a positive number of bytes (got ${maxUpload}): a zero cap refuses every upload`;
  }

  const publicUrlErr = validatePublicUrl(parsed.publicUrl);
  if (publicUrlErr !== undefined) {
    return publicUrlErr;
  }

  if (hasStorage(parsed) && !parsed.unfurlDisabled && maxUpload > MAX_REMOTE_UPLOAD) {
    return `--max-upload must be no greater than ${MAX_REMOTE_UPLOAD} bytes when remote URL upload is enabled (got ${maxUpload})`;
  }

  const fileBytesMax = defaultFileBytesMax(parsed.fileBytesMaxBytes);
  if (parsed.fileBytesEnabled && fileBytesMax <= 0) {
    return `FileBytesMaxBytes must be a positive number of bytes (got ${fileBytesMax})`;
  }

  const collabErr = validateCollabWhenDisabled(parsed);
  if (collabErr !== undefined) {
    return collabErr;
  }

  return validateS3(parsed);
}