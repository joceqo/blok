import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { S3Store } from './s3.ts';

interface Seen { method: string; path: string; body: Buffer; headers: Record<string, string> }

let backend: Server;
let seen: Seen[];
let objects: Map<string, Buffer>;
let store: S3Store;

beforeEach(async () => {
  seen = [];
  objects = new Map();
  backend = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const body = Buffer.concat(chunks);
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? '']),
      );
      seen.push({ method: request.method ?? '', path, body, headers });
      if (path === '/media/boom') {
        response.writeHead(500, { 'Content-Type': 'application/xml' });
        response.end('<Error><Code>FixtureFailure</Code></Error>');
        return;
      }
      if (request.method === 'PUT') {
        objects.set(path, body);
        response.writeHead(200).end();
        return;
      }
      if (request.method === 'DELETE') {
        objects.delete(path);
        response.writeHead(204).end();
        return;
      }
      const held = objects.get(path);
      if (held === undefined) {
        response.writeHead(404, { 'Content-Type': 'application/xml' });
        response.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response.writeHead(200, { 'Content-Length': held.length }).end(held);
    });
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
  store = new S3Store({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: 'eu-central-1',
    bucket: 'media',
    accessKey: 'AKIAEXAMPLE',
    secretKey: 'conformance-secret-key',
    publicUrl: 'https://cdn.example.com/media',
    addressing: 'path',
  });
});

afterEach(async () => {
  backend.closeAllConnections();
  await new Promise<void>((done) => backend.close(() => done()));
});

it('writes, reads back and deletes one raw key under the bucket', async () => {
  const content = Buffer.from('BKW2 working set');

  await store.putObject('collab/abc', content);

  expect(await store.getObject('collab/abc')).toEqual(content);
  expect(seen.map((request) => [request.method, request.path])).toEqual([
    ['PUT', '/media/collab/abc'],
    ['GET', '/media/collab/abc'],
  ]);
  expect(seen[0]?.headers['content-type']).toBe('application/octet-stream');
  expect(seen[0]?.body).toEqual(content);

  await store.deleteObject('collab/abc');

  expect(await store.getObject('collab/abc')).toBeUndefined();
});

it('signs every raw-key request and never sends a user agent', async () => {
  await store.putObject('collab/abc', Buffer.from('x'));

  expect(seen[0]?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
  expect(seen[0]?.headers['x-amz-content-sha256']).toBe(
    '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
  );
  expect(seen[0]?.headers['user-agent']).toBe('');
});

it('tolerates a missing key on delete but never on a failure answer', async () => {
  await expect(store.deleteObject('collab/gone')).resolves.toBeUndefined();
  await expect(store.getObject('boom')).rejects.toThrow(/s3 GET returned 500/);
  await expect(store.putObject('boom', Buffer.alloc(1))).rejects.toThrow(/s3 PUT returned 500/);
});

it('refuses an empty key rather than addressing the bucket itself', async () => {
  await expect(store.getObject('')).rejects.toThrow('blobstore: s3 key is empty');
  await expect(store.putObject('', Buffer.alloc(1))).rejects.toThrow('blobstore: s3 key is empty');
  await expect(store.deleteObject('')).rejects.toThrow('blobstore: s3 key is empty');
  expect(seen).toEqual([]);
});
