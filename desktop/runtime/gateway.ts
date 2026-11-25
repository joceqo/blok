import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { loopback, type Instance } from './instance.ts';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.json': 'application/json', '.wasm': 'application/wasm', '.avif': 'image/avif' };
const isRoom = (path: string) => path.startsWith('/api/blok/sync/');
function end(response: ServerResponse, status: number) { response.writeHead(status).end(); }

async function serveFile(root: string, pathname: string, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405);
  let path = resolve(root, '.' + decodeURIComponent(pathname));
  if (path !== root && !path.startsWith(root + sep)) return end(res, 404);
  let info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    if (extname(pathname)) return end(res, 404);
    path = resolve(root, 'index.html');
    info = await stat(path);
  }
  res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream',
    'content-length': info.size, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') res.end();
  else pipeline(createReadStream(path), res, () => {});
}

// Only the bundled loopback server renders this handoff. Browsers have their own
// session, so delegate the device page to the installed app after a user click.
function serveDevicePageLink(req: IncomingMessage, res: ServerResponse, origin: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const params = new URL(req.url!, origin).searchParams;
  const page = params.get('page');
  if (params.size !== 1 || !page || !/^[a-zA-Z0-9_-]{1,128}$/.test(page)) return false;
  const href = 'blok://page/' + page + '?origin=' + encodeURIComponent(origin);
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ouvrir la page dans Blok</title><link rel="icon" href="/favicon-32x32.png">
<style>
:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;background:light-dark(#faf9f6,#1c1c1c);color:light-dark(#272622,#f3f2ef)}
main{text-align:center;padding:24px}h1{font-size:1.6rem;margin:.6rem 0 1.25rem}
a{color:inherit;text-underline-offset:.2em}p{margin:.8rem 0}
.primary{display:inline-block;padding:.55rem 1rem;border-radius:.5rem;background:light-dark(#272622,#f3f2ef);color:light-dark(#fff,#272622);font-weight:600;text-decoration:none}
</style></head><body><main><img src="/favicon-128x128.png" width="64" height="64" alt="">
<h1>Ouvrir cette page</h1><p><a class="primary" href="${href}">Ouvrir dans Blok</a></p>
<a href="/?page=${page}&amp;web=1">Continuer dans le navigateur</a></main></body></html>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : html);
  return true;
}

// These are the shell routes that can call the private media service. Listing
// emojis and signing an existing URL use only PostgreSQL and stay available.
function needsStorage(path: string, method: string | undefined) {
  return path.startsWith('/files/') || path === '/mcp' ||
    /^\/api\/blok\/(upload|upload-by-url|delete|unfurl|frame-check|file-bytes)\/?$/.test(path) ||
    (method === 'POST' && /^\/api\/workspaces\/[^/]+\/(images|emojis)\/?$/.test(path));
}

function storageGate() {
  let state: 'starting' | 'ready' | 'failed' = 'starting';
  const waiting = new Set<() => void>();
  const reject = (res: ServerResponse) => res.writeHead(503, { 'Retry-After': '1' }).end();
  function update(next: 'ready' | 'failed') {
    state = next;
    for (const resume of waiting) resume();
  }
  return {
    update,
    run(res: ServerResponse, forward: () => void) {
      if (state === 'ready') { forward(); return; }
      if (state === 'failed' || waiting.size >= 32) { reject(res); return; }
      // Do not consume the request body until the upstream can receive it.
      // This leaves upload backpressure with the HTTP socket.
      const release = () => {
        clearTimeout(timer);
        waiting.delete(resume);
        res.off('close', release);
      };
      const resume = () => {
        release();
        if (res.destroyed) return;
        if (state === 'ready') forward();
        else reject(res);
      };
      const timer = setTimeout(resume, 20_000).unref();
      waiting.add(resume);
      res.once('close', release);
    },
  };
}

export function gateway(ports: Pick<Instance['ports'], 'public' | 'api' | 'room'>, web: string) {
  const authority = loopback + ':' + ports.public;
  const sockets = new Set<import('node:net').Socket>();
  const writes = new Map<ServerResponse, Promise<void>>();
  let closing = false;
  let ready = false;
  const storage = storageGate();
  // Only origin-form URLs are ever passed to an upstream. URIs containing encoded
  // separators or dot segments must not be interpreted differently by the backend.
  function pathname(req: IncomingMessage) {
    if (req.headers.host !== authority || !req.url?.startsWith('/') || req.url.startsWith('//')) return null;
    const raw = req.url.split('?')[0];
    if (/[\\]|%2f|%5c|%(?![0-9a-f]{2})/i.test(raw) || decodeURIComponent(raw).split('/').some(part => part === '..' || part === '.')) return null;
    return raw;
  }
  function upstream(req: IncomingMessage, port: number, upgrade: boolean) {
    const headers: IncomingHttpHeaders = { ...req.headers, host: authority, 'x-forwarded-for': loopback, 'x-forwarded-proto': 'http' };
    delete headers.forwarded;
    delete headers['x-forwarded-host'];
    if (!upgrade) { delete headers.upgrade; headers.connection = 'close'; }
    return request({ hostname: loopback, port, path: req.url, method: req.method, headers });
  }
  function proxyHttp(req: IncomingMessage, res: ServerResponse, port: number) {
    const proxy = upstream(req, port, false);
    proxy.on('error', () => { if (!res.headersSent) end(res, 502); else res.destroy(); });
    proxy.once('response', reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      pipeline(reply, res, () => {});
    });
    res.on('close', () => proxy.destroy());
    req.pipe(proxy);
  }
  const server = createServer((req, res) => {
    let path;
    try { path = pathname(req); } catch { return end(res, 400); }
    if (path === null) return end(res, 400);
    if (!ready) return end(res, 503);
    if (path === '/' && serveDevicePageLink(req, res, 'http://' + authority)) return;
    if (path === '/internal' || path.startsWith('/internal/')) return end(res, 404);
    if (!(path.startsWith('/api/') || path.startsWith('/files/') || path === '/mcp' || path === '/healthz')) {
      void serveFile(web, path, req, res).catch(() => { if (!res.headersSent) end(res, 404); else res.destroy(); });
      return;
    }
    const forward = () => proxyHttp(req, res, isRoom(path) ? ports.room : ports.api);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      writes.set(res, new Promise<void>(resolve => res.once('close', () => {
        writes.delete(res);
        resolve();
      })));
    }
    if (needsStorage(decodeURIComponent(path), req.method)) storage.run(res, forward);
    else forward();
  });
  server.on('upgrade', (req, socket, head) => {
    let path;
    try { path = pathname(req); } catch { socket.destroy(); return; }
    if (!ready || !path || !isRoom(path)) { socket.destroy(); return; }
    const proxy = upstream(req, ports.room, true);
    proxy.on('error', () => socket.destroy());
    proxy.on('response', reply => { socket.end('HTTP/1.1 ' + (reply.statusCode ?? 502) + ' Rejected\r\nConnection: close\r\n\r\n'); reply.resume(); });
    proxy.on('upgrade', (reply, remote, remoteHead) => {
      const headers = [];
      for (let i = 0; i < reply.rawHeaders.length; i += 2) headers.push(reply.rawHeaders[i] + ': ' + reply.rawHeaders[i + 1]);
      socket.write(['HTTP/1.1 101 Switching Protocols', ...headers, '', ''].join('\r\n'));
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on('error', () => socket.destroy());
      socket.on('error', () => remote.destroy());
      remote.on('close', () => socket.destroy());
      socket.on('close', () => remote.destroy());
      socket.pipe(remote).pipe(socket);
    });
    socket.on('error', () => proxy.destroy());
    socket.on('close', () => proxy.destroy());
    proxy.end();
  });
  server.on('connection', socket => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  async function stopAccepting() {
    ready = false;
    closing = true;
    // Keep the public port reserved until shutdown completes. End idle connections and
    // subscriptions immediately, but let an admitted save or upload receive its reply.
    const writing = new Set([...writes.keys()].map(res => res.socket));
    for (const socket of sockets) if (!writing.has(socket)) socket.destroy();
    if (writes.size) await Promise.race([
      Promise.all(writes.values()),
      delay(8_000, undefined, { ref: false }),
    ]);
    storage.update('failed');
    for (const socket of sockets) socket.destroy();
  }
  return { server, setStorage: storage.update, setReady: () => { ready = true; }, stopAccepting };
}
