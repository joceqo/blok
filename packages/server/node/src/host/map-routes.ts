import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DocEndpointClient } from '../collab/doc-endpoint.ts';
import { equalsOrdinalIgnoreCase } from '../dotnet/ordinal.ts';
import { isFieldValue, trimChars, type Headers } from '../http/headers.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { inGroup, Router, type RouteHandler } from '../route/router.ts';
import { methodNotAllowed, notFound, writePlain } from '../route/respond.ts';
import { PrivateS3Store } from '../blob/s3.ts';
import { LocalStore } from '../blob/local.ts';
import { readableStore, type BlobStore } from '../blob/store.ts';
import { deleteHandler } from './delete.ts';
import { fileBytesHandler } from './file-bytes.ts';
import { guardRequest } from './guard.ts';
import { localFileHandler } from './local-file.ts';
import type { HostAppOptions } from './options.ts';
import { frameCheckHandler } from './frame-check.ts';
import { unfurlHandler } from './unfurl.ts';
import { uploadByUrlHandler } from './upload-by-url.ts';
import { uploadHandler } from './upload.ts';

function isSingleSegment(doc: string): boolean {
  const lower = doc.toLowerCase();
  return doc !== '' && doc !== '.' && doc !== '..' && !/[\\/]/.test(doc) && !lower.includes('%2f') && !lower.includes('%5c');
}

function originAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (origin === '' || !isFieldValue(origin)) {
    return false;
  }
  for (const candidate of allowedOrigins) {
    if (equalsOrdinalIgnoreCase(trimChars(candidate, ' \t'), origin)) {
      return true;
    }
  }
  return false;
}

function firstHeader(headers: Headers, name: string): string {
  const direct = headers.get(name);
  return direct ?? '';
}

function preflightHandler(method: string, allowedOrigins: string[]): RouteHandler {
  return async (request, response) => {
    const origin = firstHeader(request.headers(), 'Origin');
    if (!originAllowed(origin, allowedOrigins)) {
      await writePlain(request, response, 403, 'origin not allowed\n');
      return;
    }
    const requested = firstHeader(request.headers(), 'Access-Control-Request-Headers');
    if (requested !== '' && !isFieldValue(requested)) {
      response.setStatus(500);
      response.headersMut().set('Content-Length', '0');
      await response.start(500);
      return;
    }
    const headers = response.headersMut();
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', `${method}, OPTIONS`);
    if (requested !== '') {
      headers.set('Access-Control-Allow-Headers', requested);
      headers.add('Vary', 'Access-Control-Request-Headers');
    }
    headers.set('Access-Control-Max-Age', '600');
    headers.add('Vary', 'Origin');
    response.setStatus(204);
    await response.start(204);
  };
}

function disallow(allow: string): RouteHandler {
  return (request, response) => methodNotAllowed(request, response, allow);
}

function guarded(options: HostAppOptions, requireWrite: boolean, handler: RouteHandler): RouteHandler {
  return async (request, response, values) => {
    if (!(await guardRequest(options, request, response, requireWrite, values.doc))) {
      return;
    }
    if (values.doc !== undefined && !isSingleSegment(values.doc)) {
      await writePlain(request, response, 400, 'document ids must be a single path segment\n');
      return;
    }
    await handler(request, response, values);
  };
}

function shell(router: Router, pattern: string, method: string, handler: RouteHandler, options: HostAppOptions): void {
  const requireWrite = method !== 'GET' && method !== 'HEAD';
  const methods = method === 'GET' && !pattern.includes('/sync/')
    ? [method, 'HEAD']
  : [method];
  router.handle(pattern, methods, guarded(options, requireWrite, handler));
  router.handle(pattern, ['OPTIONS'], preflightHandler(method, options.allowedOrigins));
  let allow = `${method}, OPTIONS`;
  if (method === 'POST') {
    allow = 'OPTIONS, POST';
  } else if (method === 'GET' && pattern.includes('/sync/')) {
    allow = 'GET, OPTIONS';
  } else if (method === 'GET') {
    allow = 'GET, HEAD, OPTIONS';
  }
  router.handle(pattern, undefined, disallow(allow));
}

async function healthHandler(options: HostAppOptions, request: Request, response: ResponseWriter): Promise<void> {
  const method = request.method();
  if (options.blobStore instanceof PrivateS3Store) {
    try { await options.blobStore.checkBucket(); }
    catch { await writePlain(request, response, 503, 'private storage unavailable\n'); return; }
  }
  response.headersMut().set('Content-Type', 'application/json');
  if (method === 'head') {
    response.headersMut().set('Content-Length', '0');
  }
  await response.start(200);
  if (method === 'HEAD' || method === 'head') {
    return;
  }
  const body = JSON.stringify({ status: 'ok', version: options.version }) + '\n';
  await response.write(new TextEncoder().encode(body));
}


async function unsupported(request: Request, response: ResponseWriter): Promise<void> {
  await writePlain(request, response, 501, 'collaboration operation not implemented by the Node host\n');
}

async function storedWorkingSet(directory: string, doc: string): Promise<boolean> {
  if (!directory) return false;
  const name = createHash('sha256').update(doc).digest('hex');
  try {
    await stat(join(directory, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function stateHandler(
  options: HostAppOptions, endpoint: DocEndpointClient, doc: string, request: Request, response: ResponseWriter,
): Promise<void> {
  // A journal or an existing working set can be ahead of the document projection.
  // Serving that projection as current state in those modes would lose acknowledged edits.
  if (options.collabJournal || options.collabS3Prefix) return unsupported(request, response);
  let dataJson: string;
  try {
    if (await storedWorkingSet(options.collabDirectory, doc)) return unsupported(request, response);
    const loaded = await endpoint.loadJson(doc);
    dataJson = loaded.dataJson ?? '{"blocks":[]}';
  } catch (error) {
    options.collabLog(`collab: room "${doc}" could not load: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    await writePlain(request, response, 503, 'the document could not be loaded\n');
    return;
  }
  response.headersMut().set('Cache-Control', 'no-store');
  response.headersMut().set('Content-Type', 'application/json');
  await response.start(200);
  await response.write(new TextEncoder().encode(dataJson));
}

export function buildRouter(options: HostAppOptions): Router {
  const prefix = '';
  const router = new Router();
  const patternPrefix = prefix.replace(/\/+$/, '');

  const store: BlobStore | undefined = options.blobStore
    ?? (options.storageDirectory !== ''
      ? new LocalStore(options.storageDirectory, options.publicUrl)
      : undefined);
  const hasStorage = store !== undefined;

  const reader = readableStore(store);
  if (reader && options.publicPath !== '') {
    const pattern = options.publicPath === '/' ? '/{fileName}' : `${options.publicPath}/{fileName}`;
    router.handle(pattern, ['GET', 'HEAD'], (request, response, values) =>
      localFileHandler(options, reader, request, response, values.fileName ?? ''));
  }

  router.handle(`${patternPrefix}/health`, ['GET', 'HEAD'], (request, response) => healthHandler(options, request, response));
  router.handle(`${patternPrefix}/health`, undefined, disallow('GET, HEAD'));

  if (options.fileBytesEnabled) {
    shell(router, `${patternPrefix}/file-bytes`, 'GET', (request, response) =>
      fileBytesHandler(options, reader, request, response), options);
  }

  if (hasStorage && store) {
    shell(router, `${patternPrefix}/upload`, 'POST', (request, response) =>
      uploadHandler(store, options.maxUploadBytes, request, response), options);
    shell(router, `${patternPrefix}/delete`, 'POST', (request, response) =>
      deleteHandler(store, request, response), options);
    if (options.unfurlEnabled && store) {
      shell(router, `${patternPrefix}/upload-by-url`, 'POST', (request, response) =>
        uploadByUrlHandler(store, options, request, response), options);
    }
  }

  if (options.unfurlEnabled) {
    shell(router, `${patternPrefix}/unfurl`, 'GET', (request, response) =>
      unfurlHandler(options, request, response), options);
    shell(router, `${patternPrefix}/frame-check`, 'GET', (request, response) =>
      frameCheckHandler(options, request, response), options);
    router.handle(`${patternPrefix}/frame-check`, ['POST'], (request, response) =>
      methodNotAllowed(request, response, 'GET, HEAD, OPTIONS'));
  }

  if (options.collabEnabled) {
    router.handle(`${patternPrefix}/sync/{doc}`, ['GET'], async (request, response) => {
      await writePlain(request, response, 400, 'websocket upgrade required\n');
    });
    router.handle(`${patternPrefix}/sync/{doc}`, undefined, disallow('GET'));

    const endpoint = new DocEndpointClient({ endpoint: options.docEndpoint, authorization: options.docEndpointAuth });
    shell(router, `${patternPrefix}/sync/{doc}/reset`, 'POST', unsupported, options);
    shell(router, `${patternPrefix}/sync/{doc}/edit`, 'POST', unsupported, options);
    shell(router, `${patternPrefix}/sync/{doc}/state`, 'GET', (request, response, values) =>
      stateHandler(options, endpoint, values.doc ?? '', request, response), options);
    shell(router, `${patternPrefix}/sync/{doc}/history`, 'GET', unsupported, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}/{sequence}`, 'GET', unsupported, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}`, 'DELETE', unsupported, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}/{sequence}/restore`, 'POST', unsupported, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}/{sequence}/restore/preview`, 'POST', unsupported, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}/{sequence}/changes`, 'GET', unsupported, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/at`, 'GET', unsupported, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/changes`, 'GET', unsupported, options);
  }

  router.fallback = async (request, response) => {
    if (inGroup(request, prefix)) {
      await notFound(request, response);
      return;
    }
    await notFound(request, response);
  };

  return router;
}