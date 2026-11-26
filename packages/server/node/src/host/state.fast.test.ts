import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultTestHostOptions, invokeHost } from '../test-kit/invoke-host.ts';

/**
 * GET /sync/{doc}/state on a host that keeps no journal.
 *
 * The route reaches the room, as it does with a journal and as Go does on
 * every host: there is no pass-through that hands the document endpoint's
 * bytes back unread. So the answer is what the room exports — rich text as
 * segments — not the JSON the endpoint happened to store.
 */
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
    ['empty', '{"data":null,"version":0}'],
    ['null', 'null'],
  ])('seeds an empty document from a %s endpoint response', async (doc, body) => {
    bodies.set('/docs/' + doc, body);

    const response = await read(doc);

    expect([response.status, response.body]).toEqual([200, '{"blocks":[]}']);
    expect(response.headers['cache-control']).toEqual(['no-store']);
    // No journal, so there is no head to read the state against and no tag.
    expect(response.headers.etag).toBeUndefined();
  });

  it('answers the document the endpoint holds, with its rich text as segments', async () => {
    bodies.set('/docs/rich', '{"blocks":[{"id":"a","type":"paragraph","data":{"text":"hi"}}]}');

    const response = await read('rich');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      blocks: [{ id: 'a', type: 'paragraph', data: { text: [{ text: 'hi' }] } }],
    });
  });

  it('sends the endpoint the credential it was configured with', async () => {
    bodies.set('/docs/credential', '{"blocks":[]}');

    await read('credential');

    expect(requests.at(-1)).toEqual({ method: 'GET', authorization: 'Bearer internal' });
  });

  it('recovers on the next read when the document endpoint becomes available', async () => {
    expect((await read('retry')).status).toBe(503);

    bodies.set('/docs/retry', '{"blocks":[]}');

    expect((await read('retry')).status).toBe(200);
  });

  it('checks the document scope of the verified ticket before loading state', async () => {
    const head = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ user: 'u', doc: 'mine', write: false, exp: Math.ceil(Date.now() / 1000) + 60 })).toString('base64url');
    const signed = head + '.' + payload;
    const ticket = signed + '.' + createHmac('sha256', secret).update(signed).digest('base64url');
    const req = { method: 'GET', path: '/sync/other/state', headers: { Origin: origin, Authorization: 'Bearer ' + ticket } };
    const ticketOptions = { ...options, auth: 'ticket', allowedOrigins: [origin], secret };
    const count = requests.length;

    expect((await invokeHost(ticketOptions, req)).status).toBe(403);

    // Refused before the document is fetched: a scope check that loaded first
    // would hand an unauthorized reader's id to the endpoint.
    expect(requests.length).toBe(count);
    bodies.set('/docs/mine', '{"blocks":[]}');
    expect((await invokeHost(ticketOptions, { ...req, path: '/sync/mine/state' })).status).toBe(200);
  });
});
