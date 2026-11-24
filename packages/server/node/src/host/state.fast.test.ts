import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultTestHostOptions, invokeHost } from '../test-kit/invoke-host.ts';

describe('document state on the Node host', () => {
  const origin = 'https://example.test';
  const secret = 't'.repeat(32);
  const bodies = new Map<string, string>();
  const requests: Array<{ method: string; authorization: string | undefined }> = [];
  const endpoint = createServer((request, response) => {
    requests.push({ method: request.method ?? '', authorization: request.headers.authorization });
    const body = bodies.get(request.url ?? '');
    response.writeHead(body === undefined ? 404 : 200);
    response.end(body);
  });
  const options = { ...defaultTestHostOptions(), collabEnabled: true, docEndpointAuth: 'Bearer internal' };

  beforeAll(async () => {
    options.collabDirectory = await mkdtemp(join(tmpdir(), 'blok-state-'));
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('missing endpoint address');
    options.docEndpoint = 'http://127.0.0.1:' + address.port + '/docs';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(options.collabDirectory, { recursive: true, force: true });
    await rm(options.storageDirectory, { recursive: true, force: true });
  });

  const read = (doc: string) => invokeHost(options, { method: 'GET', path: '/sync/' + doc + '/state' });
  it.each([
    ['enveloped', '{"version":"7","data":{"blocks":[{"id":9007199254740993}]}}', '{"blocks":[{"id":9007199254740993}]}'],
    ['bare', '{"blocks":[{"id":"a"}]}', '{"blocks":[{"id":"a"}]}'],
    ['empty', '{"data":null,"version":0}', '{"blocks":[]}'],
    ['null', 'null', '{"blocks":[]}'],
  ])('returns the document for a %s endpoint response', async (doc, body, expected) => {
    bodies.set('/docs/' + doc, body);
    const response = await read(doc);
    expect(response.status).toBe(200);
    expect(response.body).toBe(expected);
    expect(response.headers['cache-control']).toEqual(['no-store']);
    expect(response.headers.etag).toBeUndefined();
    expect(requests.at(-1)).toEqual({ method: 'GET', authorization: 'Bearer internal' });
  });

  it('recovers on the next read when the document endpoint becomes available', async () => {
    expect((await read('retry')).status).toBe(503);
    bodies.set('/docs/retry', '{"data":[]}');
    expect((await read('retry')).status).toBe(503);
    bodies.set('/docs/retry', '{"blocks":[]}');
    expect((await read('retry')).status).toBe(200);
  });

  it('checks the document scope of the verified ticket before loading state', async () => {
    const head = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ user: 'u', doc: 'mine', write: false, exp: Math.ceil(Date.now()/1000) + 60 })).toString('base64url');
    const signed = head + '.' + payload;
    const ticket = signed + '.' + createHmac('sha256', secret).update(signed).digest('base64url');
    const req = { method: 'GET', path: '/sync/other/state', headers: { Origin: origin, Authorization: 'Bearer ' + ticket } };
    const ticketOptions = { ...options, auth: 'ticket', allowedOrigins: [origin], secret };
    const count = requests.length;
    expect((await invokeHost(ticketOptions, req)).status).toBe(403);
    expect(requests.length).toBe(count);
    bodies.set('/docs/mine', '{"blocks":[]}');
    expect((await invokeHost(ticketOptions, { ...req, path: '/sync/mine/state' })).status).toBe(200);
  });

  it('refuses stale projections when the configured store can hold newer state', async () => {
    bodies.set('/docs/stored', '{"blocks":[]}');
    const req = { method: 'GET', path: '/sync/stored/state' };
    const count = requests.length;
    expect((await invokeHost({ ...options, collabJournal: true }, req)).status).toBe(501);
    expect((await invokeHost({ ...options, collabS3Prefix: 'working-sets' }, req)).status).toBe(501);
    await writeFile(join(options.collabDirectory, createHash('sha256').update('stored').digest('hex')), 'working set');
    expect((await invokeHost(options, req)).status).toBe(501);
    expect(requests.length).toBe(count);
  });

  it('does not acknowledge unimplemented mutations or rewrite the loaded document', async () => {
    const count = requests.length;
    for (const [method, route] of [['POST', 'edit'], ['POST', 'reset'], ['POST', 'history/l/1/restore'], ['GET', 'history']]) {
      expect((await invokeHost(options, { method: method!, path: '/sync/doc/' + route })).status).toBe(501);
    }
    expect(requests.length).toBe(count);
  });
});
