import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { requestThroughProxy } from './s3-proxy-request.ts';

/**
 * A proxy that answers one response, written in pieces: a real one hands the
 * body back across as many TCP reads as the network gives it.
 */
let proxy: Server;
let port: number;
let answer: (write: (chunk: string | Buffer) => void, end: () => void) => void;
let seen: string;

beforeEach(async () => {
  seen = '';
  proxy = createServer((socket) => {
    socket.once('data', (chunk: Buffer) => {
      seen = chunk.toString('latin1');
      answer((piece) => socket.write(piece), () => socket.end());
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
  port = address.port;
});

afterEach(async () => {
  await new Promise<void>((done) => proxy.close(() => done()));
});

const through = (method: string): Promise<{ status: number; body: Buffer }> =>
  requestThroughProxy(`http://bucket.invalid/media/collab/abc`, method, {}, undefined, { scheme: 'http', host: '127.0.0.1', port });

it('reads a whole object body that arrives after the headers', async () => {
  const content = Buffer.alloc(9000, 7);

  answer = ((write, end) => {
    write(`HTTP/1.1 200 OK\r\nContent-Length: ${content.length}\r\n\r\n`);
    write(content.subarray(0, 100));
    setTimeout(() => {
      write(content.subarray(100));
      end();
    }, 5);
  });

  const response = await through('GET');

  expect([response.status, response.body.length]).toEqual([200, content.length]);
  expect(response.body).toEqual(content);
  expect(seen.startsWith('GET http://bucket.invalid/media/collab/abc HTTP/1.1\r\n')).toBe(true);
});

it('refuses a body the proxy cut short rather than answering half an object', async () => {
  answer = ((write, end) => {
    write('HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n');
    write(Buffer.alloc(10));
    end();
  });

  await expect(through('GET')).rejects.toThrow('blobstore: the proxy ended the response body early');
});

it('answers a response that declares no body as soon as its headers land', async () => {
  answer = ((write) => write('HTTP/1.1 200 OK\r\nETag: "fixture"\r\n\r\n'));

  expect((await through('PUT')).status).toBe(200);
});
