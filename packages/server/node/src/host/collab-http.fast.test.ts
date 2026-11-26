import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pageDirectory } from '../collab/room/page-seed.ts';
import { defaultTestHostOptions, invokeHost } from '../test-kit/invoke-host.ts';
import type { HostAppOptions } from './options.ts';

/**
 * The collaboration routes beside the sync door, driven through the host's own
 * router. The black-box conformance suite is the contract; this covers the
 * wire layer the host owns: which refusal each malformed request earns, and
 * that a well-formed one reaches the room and comes back as JSON.
 */
describe('collaboration HTTP routes on the Node host', () => {
  const bodies = new Map<string, string>();
  const endpoint = createServer((request, response) => {
    const body = bodies.get(request.url ?? '');
    response.writeHead(body === undefined ? 404 : 200);
    response.end(body);
  });
  let options: HostAppOptions;

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blok-collab-http-'));
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

  const get = (path: string, headers?: Record<string, string>) =>
    invokeHost(options, { method: 'GET', path, headers });

  /** The lineage the seeded document is on, read off its own state. */
  const lineage = async (): Promise<string> => {
    const answer = await get('/sync/d/state');

    expect(answer.status).toBe(200);

    return answer.headers['blok-doc-lineage']?.[0] ?? '';
  };

  it('serves the state the room holds, with its head and an ETag an If-Match takes', async () => {
    const answer = await get('/sync/d/state');

    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']?.[0]).toBe('application/json');
    expect(answer.headers['cache-control']?.[0]).toBe('no-store');
    expect(answer.headers['blok-doc-lineage']?.[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(answer.headers['blok-doc-sequence']?.[0]).toBe('0');
    expect(answer.headers.etag?.[0]).toBe(`"${answer.headers['blok-doc-lineage']?.[0]}:0"`);
    expect(JSON.parse(answer.body)).toMatchObject({ blocks: [] });
  });

  it('names the head headers a browser page may read back', async () => {
    const allowed = { ...options, allowedOrigins: ['https://app.example.com'] };
    const answer = await invokeHost(allowed, {
      method: 'GET',
      path: '/sync/d/state',
      headers: { Origin: 'https://app.example.com' },
    });

    expect(answer.headers['access-control-expose-headers']?.[0]).toBe('Blok-Doc-Lineage, Blok-Doc-Sequence, ETag');
  });

  it('lists the lineage and its baseline version', async () => {
    const answer = await get('/sync/d/history');
    const body = JSON.parse(answer.body) as {
      lineages: { lineage: string; current: boolean }[];
      versions: { sequence: number }[];
    };

    expect([answer.status, answer.headers['content-type']?.[0], answer.headers['cache-control']?.[0]])
      .toEqual([200, 'application/json', 'no-store']);
    expect(Object.keys(body)).toEqual(['lineages', 'versions']);
    expect(body.lineages[0]?.current).toBe(true);
    expect(body.versions.map((version) => version.sequence)).toEqual([0]);
  });

  it('reads the baseline point with its own history headers', async () => {
    const answer = await get(`/sync/d/history/${await lineage()}/0`);

    expect([answer.status, answer.headers['blok-history-sequence']?.[0]]).toEqual([200, '0']);
    expect(answer.headers.etag?.[0]).toBeUndefined();
    expect(JSON.parse(answer.body)).toMatchObject({ blocks: [] });
  });

  it.each([
    ['?group=7', 'group must be 1, 15 or 60\n'],
    ['?group=', 'group must be 1, 15 or 60\n'],
    ['?group=1&group=1', 'group must be 1, 15 or 60\n'],
    ['?GROUP=7', 'group must be 1, 15 or 60\n'],
    ['?group=1%00x', 'group must be 1, 15 or 60\n'],
  ])('refuses the list query %s', async (query, text) => {
    const answer = await get(`/sync/d/history${query}`);

    expect([answer.status, answer.body]).toEqual([400, text]);
  });

  it.each(['?GROUP=60', '?group=1%00', '?group=%31'])('reads the list query %s like ASP.NET does', async (query) => {
    expect((await get(`/sync/d/history${query}`)).status).toBe(200);
  });

  it('refuses a sequence that is not a whole number, and does not know an unlineaged point', async () => {
    const signed = await get(`/sync/d/history/${await lineage()}/+1`);

    expect([signed.status, signed.body]).toEqual([400, 'the sequence must be a whole number\n']);

    const unknown = await get('/sync/d/history/not-a-lineage/0');

    expect([unknown.status, unknown.body]).toEqual([404, 'no such version\n']);

    const past = await get(`/sync/d/history/${await lineage()}/9`);

    expect([past.status, past.body]).toEqual([404, 'no such version\n']);
  });

  it.each(['?since=2', '?since=', '?since=0&since=0', '?since=0;x'])('refuses the changes query %s', async (query) => {
    const answer = await get(`/sync/d/history/${await lineage()}/0/changes${query}`);

    expect([answer.status, answer.body]).toEqual([400, 'since must be a whole number no greater than the sequence\n']);
  });

  it('answers an empty window for the baseline', async () => {
    const answer = await get(`/sync/d/history/${await lineage()}/0/changes`);

    expect([answer.status, answer.body]).toEqual([200, '{"changes":[]}']);
  });

  it.each([
    ['/sync/d/history/at', 'time must be an ISO 8601 time with an offset\n'],
    ['/sync/d/history/at?time=1791552000000', 'time must be an ISO 8601 time with an offset\n'],
    ['/sync/d/history/at?time=2026-10-07T12:00:00', 'time must be an ISO 8601 time with an offset\n'],
    ['/sync/d/history/changes?from=2999-01-01T00:00:00Z&to=2000-01-01T00:00:00Z',
      'from and to must be ISO 8601 times with an offset, from no later than to\n'],
    ['/sync/d/history/changes?before=x', 'before must be one <lineage>:<sequence>\n'],
    ['/sync/d/history/changes?detail=all', 'detail must be properties\n'],
    ['/sync/d/history/changes?block=', 'block must be one block id\n'],
  ])('refuses %s', async (path, text) => {
    const answer = await get(path);

    expect([answer.status, answer.body]).toEqual([400, text]);
  });

  it('answers 404 as JSON for a time before the history starts', async () => {
    const answer = await get('/sync/d/history/at?time=2000-01-01T00:00:00Z', { Accept: 'application/json' });

    expect([answer.status, answer.headers['content-type']?.[0], answer.body])
      .toEqual([404, 'application/json', '{"reason":"not_found"}']);
  });

  it('redirects to the same point whether or not the at route is asked with a trailing slash', async () => {
    const current = await lineage();
    const reached: string[] = [];

    for (const path of ['/sync/d/history/at', '/sync/d/history/at/']) {
      const answer = await get(`${path}?time=2999-01-01T00:00:00Z`);

      expect([path, answer.status]).toEqual([path, 302]);
      // The Location is relative, so it keeps the mount prefix and the doc as
      // sent. A trailing slash puts the base one level deeper, under .../at/,
      // and the Location has to climb back out of it.
      reached.push(new URL(answer.headers.location?.[0] ?? '', new URL(path, 'http://host')).pathname);
    }

    expect(reached).toEqual([`/sync/d/history/${current}/0`, `/sync/d/history/${current}/0`]);
  });

  it('takes the at and changes literals as versions a DELETE never finds', async () => {
    for (const path of ['/sync/d/history/at', '/sync/d/history/changes']) {
      const answer = await invokeHost(options, { method: 'DELETE', path });

      expect([path, answer.status, answer.body]).toEqual([path, 404, 'no such version\n']);
    }
  });

  it('refuses to delete the lineage the document is on', async () => {
    const answer = await invokeHost(options, { method: 'DELETE', path: `/sync/d/history/${await lineage()}` });

    expect([answer.status, answer.body]).toEqual([409, 'the document is on this lineage; it cannot be deleted\n']);
  });

  it('needs an idempotency key and a well-formed If-Match to restore', async () => {
    const at = `/sync/d/history/${await lineage()}/0/restore`;
    const missing = await invokeHost(options, { method: 'POST', path: at });

    expect([missing.status, missing.body]).toEqual([400, 'a valid Blok-Idempotency-Key header is required\n']);

    const weak = await invokeHost(options, {
      method: 'POST',
      path: at,
      headers: { 'Blok-Idempotency-Key': 'r1', 'If-Match': 'W/"0123456789abcdef0123456789abcdef:1"' },
    });

    expect([weak.status, weak.body]).toEqual([400, 'If-Match must be one quoted "<lineage>:<sequence>" tag\n']);

    const long = await invokeHost(options, {
      method: 'POST',
      path: at,
      headers: { 'Blok-Idempotency-Key': 'k'.repeat(129) },
    });

    expect(long.status).toBe(400);
  });

  it('plans a restore with no key at all, and answers 412 on a stale If-Match', async () => {
    const current = await lineage();
    const preview = await invokeHost(options, {
      method: 'POST',
      path: `/sync/d/history/${current}/0/restore/preview`,
    });
    const planned = JSON.parse(preview.body) as { expectRevision: string; fits: boolean };

    expect([preview.status, preview.headers['content-type']?.[0]]).toEqual([200, 'application/json']);
    expect([planned.expectRevision, planned.fits]).toEqual([`${current}:0`, true]);

    const stale = await invokeHost(options, {
      method: 'POST',
      path: `/sync/d/history/${current}/0/restore/preview`,
      headers: { 'If-Match': `"${current}:7"` },
    });

    expect([stale.status, stale.headers['blok-doc-sequence']?.[0]]).toEqual([412, '0']);
  });

  it('serves the room\'s state with no head at all when the host keeps no journal', async () => {
    const plain = { ...options, collabJournal: false, collabDirectory: await mkdtemp(join(tmpdir(), 'blok-collab-plain-')) };

    try {
      const edit = await invokeHost(plain, {
        method: 'POST',
        path: '/sync/d/edit',
        headers: { 'Blok-Idempotency-Key': 'k1' },
        body: '{"ops":[{"op":"insert","id":"b1","block":{"type":"paragraph","data":{"text":"hello"}}}]}',
      });

      expect(edit.status).toBe(204);

      const answer = await invokeHost(plain, { method: 'GET', path: '/sync/d/state' });
      const page = JSON.parse(answer.body) as { blocks: { id: string }[] };

      expect([answer.status, answer.headers['content-type']?.[0], answer.headers['cache-control']?.[0]])
        .toEqual([200, 'application/json', 'no-store']);
      // No journal, so there is no point to name: the three head headers a
      // caller would read one off are all withheld, as they are off an edit.
      expect([answer.headers.etag, answer.headers['blok-doc-lineage'], answer.headers['blok-doc-sequence']])
        .toEqual([undefined, undefined, undefined]);
      expect(page.blocks.map((block) => block.id)).toEqual(['b1']);
    } finally {
      await rm(plain.collabDirectory, { recursive: true, force: true });
    }
  });

  it('reads a corrupt journal as a document that would not load on state, and names it only on history', async () => {
    const corrupt = { ...options, collabDirectory: await mkdtemp(join(tmpdir(), 'blok-collab-corrupt-')) };

    try {
      const edit = await invokeHost(corrupt, {
        method: 'POST',
        path: '/sync/d/edit',
        headers: { 'Blok-Idempotency-Key': 'c1' },
        body: '{"ops":[{"op":"insert","id":"b1","block":{"type":"paragraph","data":{"text":"one"}}}]}',
      });

      expect(edit.status).toBe(204);

      const page = pageDirectory(corrupt.collabDirectory, 'd');
      const name = (await readdir(page)).find((entry) => entry.startsWith('journal.')) ?? '';
      const bytes = await readFile(join(page, name));

      expect(bytes.length).toBeGreaterThan(0);
      await writeFile(join(page, name), Buffer.concat([
        bytes.subarray(0, bytes.length - 1),
        Buffer.of((bytes.at(-1) ?? 0) ^ 0xff),
      ]));

      const history = await invokeHost(corrupt, { method: 'GET', path: '/sync/d/history' });

      expect([history.status, history.body]).toEqual([500, 'a stored version could not be read\n']);

      // Only a history route may name a stored version. The state door answers
      // for the document, which is one that would not load.
      const state = await invokeHost(corrupt, { method: 'GET', path: '/sync/d/state' });

      expect([state.status, state.body]).toEqual([503, 'the document could not be loaded\n']);
    } finally {
      await rm(corrupt.collabDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it('answers every history route 501 when the host keeps no journal', async () => {
    const plain = { ...options, collabJournal: false };

    for (const [method, path] of [
      ['GET', '/sync/d/history'],
      ['GET', '/sync/d/history/l/1'],
      ['GET', '/sync/d/history/0123456789abcdef0123456789abcdef/0/changes'],
      ['DELETE', '/sync/d/history/l'],
      ['POST', '/sync/d/history/l/1/restore'],
      ['POST', '/sync/d/history/l/1/restore/preview'],
      ['GET', '/sync/d/history/at'],
      ['GET', '/sync/d/history/changes'],
    ] as [string, string][]) {
      const answer = await invokeHost(plain, { method, path });

      expect({ path, status: answer.status, text: answer.body, cache: answer.headers['cache-control']?.[0] })
        .toEqual({ path, status: 501, text: 'history needs a journal that keeps it\n', cache: 'no-store' });
    }
  });
});
