import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';

import { DocEndpointClient } from './doc-endpoint.ts';

/**
 * The write-back half of the consumer's document routes. A room PUTs the
 * projection and reads back the handle the consumer answers with, because an
 * endpoint that versions its records hands out a new one on every write — a
 * room that kept the handle it loaded with would be refused from the second
 * write on.
 */
interface Recorded {
  body: string;
  headers: IncomingMessage['headers'];
}

let server: Server | undefined;

afterEach(async () => {
  const running = server;

  server = undefined;
  if (running) {
    await new Promise<void>((done) => running.close(() => done()));
  }
});

async function endpointAnswering(answer: { status: number; body: string }): Promise<{ url: string; puts: Recorded[] }> {
  const puts: Recorded[] = [];
  const running = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      puts.push({ body, headers: request.headers });
      response.writeHead(answer.status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(answer.body);
    });
  });

  server = running;
  await new Promise<void>((done) => running.listen(0, '127.0.0.1', done));

  const address = running.address();

  if (address === null || typeof address === 'string') {
    throw new Error('The endpoint has no TCP address');
  }

  return { url: `http://127.0.0.1:${address.port}/docs`, puts };
}

it('answers the version the endpoint handed back, and sends the one it was given', async () => {
  const { url, puts } = await endpointAnswering({ status: 200, body: '{"version":"v8"}' });
  const client = new DocEndpointClient({ endpoint: url, authorization: '' });

  await expect(client.save('page-1', { blocks: [] }, 'v7')).resolves.toBe('v8');
  expect(puts[0]?.headers['blok-doc-version']).toBe('v7');
  expect(puts[0]?.body).toBe('{"blocks":[]}');
});

it('answers nothing when the endpoint answers nothing, so the loaded version stands', async () => {
  const { url } = await endpointAnswering({ status: 204, body: '' });
  const client = new DocEndpointClient({ endpoint: url, authorization: '' });

  await expect(client.save('page-1', { blocks: [] }, 'v7')).resolves.toBeUndefined();
});

it('names the generation the projection was taken from, so a stale write-back can be refused', async () => {
  const { url, puts } = await endpointAnswering({ status: 204, body: '' });
  const client = new DocEndpointClient({ endpoint: url, authorization: '' });

  await client.save('page-1', { blocks: [] }, undefined, { lineage: 'abc', sequence: 42n });

  expect(puts[0]?.headers['blok-doc-lineage']).toBe('abc');
  expect(puts[0]?.headers['blok-doc-sequence']).toBe('42');
  expect(puts[0]?.headers['blok-doc-version']).toBeUndefined();
});
