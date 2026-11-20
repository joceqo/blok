import http from 'node:http';
import https from 'node:https';
import { eqIgnoreAsciiCase, isFieldValue, trimChars, type Headers } from '../http/headers.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { inGroup, Router, type RouteHandler } from '../route/router.ts';
import { methodNotAllowed, notFound, writePlain } from '../route/respond.ts';
import { LocalStore } from '../blob/local.ts';
import { deleteHandler } from './delete.ts';
import { fileBytesHandler } from './file-bytes.ts';
import { guardRequest } from './guard.ts';
import { localFileHandler } from './local-file.ts';
import type { HostAppOptions } from './options.ts';
import { uploadHandler } from './upload.ts';

function isSingleSegment(doc: string): boolean {
  const lower = doc.toLowerCase();
  return doc !== '' && !/[\\/]/.test(doc) && !lower.includes('%2f') && !lower.includes('%5c');
}

function originAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (origin === '' || !isFieldValue(origin)) {
    return false;
  }
  for (const candidate of allowedOrigins) {
    if (eqIgnoreAsciiCase(trimChars(candidate, ' \t'), origin)) {
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
    if (!(await guardRequest(options, request, response, requireWrite))) {
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


async function stateHandler(options: HostAppOptions, request: Request, response: ResponseWriter, values: Record<string, string>): Promise<void> {
  const doc = values.doc ?? '';
  if (!isSingleSegment(doc)) {
    await writePlain(request, response, 400, 'document ids must be a single path segment\n');
    return;
  }
  if (options.docEndpoint === '') {
    await writePlain(request, response, 503, 'the document could not be loaded\n');
    return;
  }
  let text: string;
  try {
    text = await loadDocText(options.docEndpoint, doc);
  } catch {
    await writePlain(request, response, 503, 'the document could not be loaded\n');
    return;
  }
  response.headersMut().set('Cache-Control', 'no-store');
  response.headersMut().set('Content-Type', 'application/json');
  await response.start(200);
  if (request.method() !== 'HEAD') {
    await response.write(new TextEncoder().encode(text));
  }
}

async function stubNoContent(request: Request, response: ResponseWriter): Promise<void> {
  response.setStatus(204);
  await response.start(204);
}

async function stubUnfurl(request: Request, response: ResponseWriter): Promise<void> {
  await notFound(request, response);
}

function loadDocText(endpoint: string, doc: string): Promise<string> {
  const base = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  const prefix = base.pathname.replace(/\/$/, '');
  const path = `${prefix}/${encodeURIComponent(doc)}`;
  const requester = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = requester.request(
      {
        hostname: base.hostname,
        port: base.port === '' ? undefined : base.port,
        path,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if ((res.statusCode ?? 500) !== 200) {
            reject(new Error(String(res.statusCode)));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export function buildRouter(options: HostAppOptions): Router {
  const prefix = '';
  const router = new Router();
  const patternPrefix = prefix.replace(/\/+$/, '');

  const hasStorage = options.storageDirectory !== '';
  const store = hasStorage ? new LocalStore(options.storageDirectory, options.publicUrl) : undefined;

  const hasLocalFiles = hasStorage && options.publicPath !== '';
  if (hasLocalFiles && store) {
    const pattern = options.publicPath === '/' ? '/{fileName}' : `${options.publicPath}/{fileName}`;
    router.handle(pattern, ['GET', 'HEAD'], (request, response, values) =>
      localFileHandler(options, store, request, response, values.fileName ?? ''));
  }

  router.handle(`${patternPrefix}/health`, ['GET', 'HEAD'], (request, response) => healthHandler(options, request, response));
  router.handle(`${patternPrefix}/health`, undefined, disallow('GET, HEAD'));

  if (options.fileBytesEnabled) {
    shell(router, `${patternPrefix}/file-bytes`, 'GET', (request, response) =>
      fileBytesHandler(options, store, request, response), options);
  }

  if (hasStorage && store) {
    shell(router, `${patternPrefix}/upload`, 'POST', (request, response) =>
      uploadHandler(store, options.maxUploadBytes, request, response), options);
    shell(router, `${patternPrefix}/delete`, 'POST', (request, response) =>
      deleteHandler(store, request, response), options);
    if (options.unfurlEnabled) {
      shell(router, `${patternPrefix}/upload-by-url`, 'POST', async (request, response) => {
        await writePlain(request, response, 400, 'malformed upload\n');
      }, options);
    }
  }

  if (options.unfurlEnabled) {
    shell(router, `${patternPrefix}/unfurl`, 'GET', stubUnfurl, options);
    shell(router, `${patternPrefix}/frame-check`, 'GET', stubUnfurl, options);
  }

  if (options.collabEnabled) {
    router.handle(`${patternPrefix}/sync/{doc}`, ['GET'], async (request, response) => {
      await writePlain(request, response, 400, 'websocket upgrade required\n');
    });
    router.handle(`${patternPrefix}/sync/{doc}`, undefined, disallow('GET'));

    shell(router, `${patternPrefix}/sync/{doc}/reset`, 'POST', stubNoContent, options);
    shell(router, `${patternPrefix}/sync/{doc}/edit`, 'POST', stubNoContent, options);
    shell(router, `${patternPrefix}/sync/{doc}/state`, 'GET', (request, response, values) =>
      stateHandler(options, request, response, values), options);
    shell(router, `${patternPrefix}/sync/{doc}/history`, 'GET', stubNoContent, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}/{sequence}`, 'GET', stubNoContent, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}`, 'DELETE', stubNoContent, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}/{sequence}/restore`, 'POST', stubNoContent, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}/{sequence}/restore/preview`, 'POST', stubNoContent, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/{lineage}/{sequence}/changes`, 'GET', stubNoContent, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/at`, 'GET', stubNoContent, options);
    shell(router, `${patternPrefix}/sync/{doc}/history/changes`, 'GET', stubNoContent, options);
  }

  const groupNotFound: RouteHandler = (request, response) => notFound(request, response);
  router.fallback = async (request, response) => {
    if (inGroup(request, prefix)) {
      await groupNotFound(request, response);
      return;
    }
    await notFound(request, response);
  };

  return router;
}