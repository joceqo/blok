import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_APPEND_BYTES } from '../collab/journal/append.ts';
import { defaultConfig } from '../http/config.ts';
import { serve } from '../http/conn.ts';
import { Shared } from '../http/server.ts';
import { defaultTestHostOptions, invokeHost } from '../test-kit/invoke-host.ts';
import { parseHttpResponse, type ParsedHttpResponse } from '../test-kit/parse-http-response.ts';
import { createHostHandler } from './app.ts';
import type { HostAppOptions } from './options.ts';

/**
 * The write door of the collaboration HTTP surface: POST /sync/{doc}/edit.
 *
 * The black-box conformance suite owns the contract; this covers the wire
 * layer the Node host owns — which refusal each malformed request earns
 * before the room is reached at all, and that a well-formed one commits.
 */
describe('the edit route on the Node host', () => {
  const bodies = new Map<string, string>();
  const endpoint = createHttpServer((request, response) => {
    const body = bodies.get(request.url ?? '');
    response.writeHead(body === undefined ? 404 : 200);
    response.end(body);
  });
  let options: HostAppOptions;

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blok-collab-edit-'));
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('missing endpoint address');
    bodies.set('/docs/d', '{"blocks":[]}');
    options = {
      ...defaultTestHostOptions(),
      collabEnabled: true,
      collabJournal: true,
      collabDirectory: directory,
      docEndpoint: 'http://127.0.0.1:' + address.port + '/docs',
    };
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(options.collabDirectory, { recursive: true, force: true });
    await rm(options.storageDirectory, { recursive: true, force: true });
  });

  const KEY = 'Blok-Idempotency-Key';
  const BAD_KEY = 'a valid Blok-Idempotency-Key header is required\n';
  const BAD_IF_MATCH = 'If-Match must be one quoted "<lineage>:<sequence>" tag\n';
  const LINEAGE = '0123456789abcdef0123456789abcdef';
  const ONE_OP = '{"ops":[{"op":"remove","id":"b1"}]}';

  const post = (headers: Record<string, string>, body?: Uint8Array | string) =>
    invokeHost(options, { method: 'POST', path: '/sync/d/edit', headers, body });

  /**
   * One request written onto a real socket, which is the only way to send a
   * header name twice: the in-process kit folds a repeated name into one line.
   */
  async function raw(host: HostAppOptions, lines: string[], body = ''): Promise<ParsedHttpResponse> {
    const shared = new Shared(createHostHandler(host), defaultConfig());
    const server = createTcpServer((socket) => void serve(shared, socket, () => {}));
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
    const { port } = server.address() as { port: number };
    const client = connect({ host: '127.0.0.1', port });
    const parts: Buffer[] = [];
    const answered = new Promise<Buffer>((done, failed) => {
      client.on('data', (chunk: Buffer) => parts.push(chunk));
      client.once('end', () => done(Buffer.concat(parts)));
      client.once('error', failed);
    });
    await new Promise<void>((ready, failed) => {
      client.once('connect', () => ready());
      client.once('error', failed);
    });
    const head = [...lines, `Content-Length: ${body.length}`, 'Connection: close', '', ''].join('\r\n');
    client.write(head + body);
    const bytes = await answered;
    client.destroy();
    await new Promise<void>((closed) => server.close(() => closed()));

    return parseHttpResponse(bytes);
  }

  const REQUEST = ['POST /sync/d/edit HTTP/1.1', 'Host: 127.0.0.1'];

  it('needs one idempotency key, and takes no other shape of one', async () => {
    const missing = await post({}, ONE_OP);

    expect([missing.status, missing.body]).toEqual([400, BAD_KEY]);

    const long = await post({ [KEY]: 'k'.repeat(129) }, ONE_OP);

    expect([long.status, long.body]).toEqual([400, BAD_KEY]);

    const empty = await post({ [KEY]: '' }, ONE_OP);

    expect([empty.status, empty.body]).toEqual([400, BAD_KEY]);
  });

  it('refuses an idempotency key sent on two header lines', async () => {
    const answer = await raw(options, [...REQUEST, `${KEY}: one`, `${KEY}: two`], ONE_OP);

    expect([answer.status, answer.body]).toEqual([400, BAD_KEY]);
  });

  it.each([
    ['a weak tag', `W/"${LINEAGE}:1"`],
    ['the any-tag star', '*'],
    ['a lineage in capitals', `"${LINEAGE.toUpperCase()}:1"`],
    ['a sequence with a leading zero', `"${LINEAGE}:01"`],
    ['a sequence past 2^64-1', `"${LINEAGE}:18446744073709551616"`],
    ['a tag list', `"${LINEAGE}:1", "${LINEAGE}:2"`],
  ])('refuses %s as an If-Match', async (_what, tag) => {
    const answer = await post({ [KEY]: 'e1', 'If-Match': tag }, ONE_OP);

    expect([answer.status, answer.body]).toEqual([400, BAD_IF_MATCH]);
  });

  it('refuses an If-Match sent on two header lines', async () => {
    const answer = await raw(
      options,
      [...REQUEST, `${KEY}: e2`, `If-Match: "${LINEAGE}:1"`, `If-Match: "${LINEAGE}:2"`],
      ONE_OP,
    );

    expect([answer.status, answer.body]).toEqual([400, BAD_IF_MATCH]);
  });

  it('has nothing to match an If-Match against when it keeps no journal', async () => {
    const plain = { ...options, collabJournal: false };
    const answer = await invokeHost(plain, {
      method: 'POST',
      path: '/sync/d/edit',
      headers: { [KEY]: 'e3', 'If-Match': `"${LINEAGE}:1"` },
      body: ONE_OP,
    });

    expect([answer.status, answer.body])
      .toEqual([428, 'If-Match needs the operation journal, and this server keeps none\n']);
  });

  it('reads no more than one megabyte of edit', async () => {
    const tooBig = new Uint8Array(MAX_APPEND_BYTES + 1).fill(0x20);
    const answer = await post({ [KEY]: 'e4' }, tooBig);

    expect([answer.status, answer.body]).toEqual([413, 'an edit request is at most 1048576 bytes\n']);
  });

  it('names what is wrong with a body that is not an edit', async () => {
    const broken = await post({ [KEY]: 'e5' }, '{"ops":');

    expect([broken.status, broken.body]).toEqual([422, 'collab: the request body is not valid JSON.\n']);

    const empty = await post({ [KEY]: 'e6' }, '{"ops":[]}');

    expect([empty.status, empty.body])
      .toEqual([422, 'collab: the request body must be an object with a non-empty "ops" array.\n']);
  });

  it('commits a well-formed edit and answers with the head it reached', async () => {
    const answer = await post(
      { [KEY]: 'e7' },
      '{"ops":[{"op":"insert","id":"b1","block":{"type":"paragraph","data":{"text":"hi"}}}]}',
    );

    expect([answer.status, answer.body]).toEqual([204, '']);
    expect(answer.headers['blok-doc-lineage']?.[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(answer.headers['blok-doc-sequence']?.[0]).toBe('1');
  });

  /**
   * The validation pass is wired, not merely written: without it `addBlockAt`
   * overwrites whatever block already holds that id, and the loss is silent.
   */
  it('refuses an insert naming an id the document already holds, in its own words', async () => {
    const taken = '{"ops":[{"op":"insert","id":"b1","block":{"type":"paragraph","data":{"text":"again"}}}]}';

    const answer = await post({ [KEY]: 'e8' }, taken);

    expect(answer.status).toBe(422);
    expect(answer.body).toContain('b1');
  });
});

