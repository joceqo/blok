import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.ts';
import { onError } from './error.ts';
import { type ObserveLine, observeMiddleware } from './observe.ts';

const HEX_32 = /^[0-9a-f]{32}$/;

function collector(): { lines: ObserveLine[]; log: (line: ObserveLine) => void } {
  const lines: ObserveLine[] = [];
  return { lines, log: (line) => void lines.push(line) };
}

function clock(...stamps: readonly number[]): () => number {
  let reading = 0;
  return () => stamps[Math.min(reading++, stamps.length - 1)] ?? 0;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('observeMiddleware', () => {
  it('stays silent on a request that was served quickly', async () => {
    const { lines, log } = collector();
    const app = new Hono();
    app.use('*', observeMiddleware({ log, now: clock(0, 12) }));
    app.get('/health', (context) => context.json({ status: 'ok' }));

    const response = await app.request('http://localhost/health');

    expect(response.status).toBe(200);
    expect(lines).toEqual([]);
  });

  it('keeps a refusal, with the reason the status code cannot carry', async () => {
    const { lines, log } = collector();
    const app = new Hono();
    app.use('*', observeMiddleware({ log, now: clock(0, 7) }));
    app.get('/api/pages/:id', (context) =>
      context.json({ error: 'permission_denied' }, 403),
    );

    await app.request('http://localhost/api/pages/abc');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      message: 'request refused',
      method: 'GET',
      path: '/api/pages/abc',
      status: 403,
      ms: 7,
      cause: '{"error":"permission_denied"}',
    });
    expect(lines[0]?.request).toMatch(HEX_32);
  });

  it('raises a server refusal to error level', async () => {
    const { lines, log } = collector();
    const app = new Hono();
    app.use('*', observeMiddleware({ log, now: clock(0, 3) }));
    app.get('/boom', (context) => context.json({ error: 'nope' }, 500));

    await app.request('http://localhost/boom');

    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.message).toBe('request refused');
  });

  it('keeps an answered request that crossed the slow threshold', async () => {
    const { lines, log } = collector();
    const app = new Hono();
    app.use('*', observeMiddleware({ log, now: clock(0, 2000) }));
    app.get('/export', (context) => context.json({ ok: true }));

    await app.request('http://localhost/export');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      message: 'request slow',
      status: 200,
      ms: 2000,
      cause: '',
    });
  });

  it('leaves an answered request just under the threshold alone', async () => {
    const { lines, log } = collector();
    const app = new Hono();
    app.use('*', observeMiddleware({ log, now: clock(0, 1999) }));
    app.get('/export', (context) => context.json({ ok: true }));

    await app.request('http://localhost/export');

    expect(lines).toEqual([]);
  });

  it('bounds what a refusal body contributes to one line', async () => {
    const { lines, log } = collector();
    const app = new Hono();
    app.use('*', observeMiddleware({ log, now: clock(0, 1) }));
    app.get('/long', (context) => context.text('x'.repeat(4096), 400));

    await app.request('http://localhost/long');

    expect(lines[0]?.cause).toBe('x'.repeat(256));
  });

  it('leaves the refusal body intact for the client', async () => {
    const { log } = collector();
    const app = new Hono();
    app.use('*', observeMiddleware({ log, now: clock(0, 1) }));
    app.get('/denied', (context) =>
      context.json({ error: 'permission_denied' }, 403),
    );

    const response = await app.request('http://localhost/denied');

    await expect(response.json()).resolves.toEqual({
      error: 'permission_denied',
    });
  });

  it('stops pulling a streamed refusal once it has its reason', async () => {
    const { lines, log } = collector();
    let pulled = 0;
    const app = new Hono();
    app.use('*', observeMiddleware({ log, now: clock(0, 1) }));
    app.get('/stream', (context) => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new TextEncoder().encode('y'.repeat(64)));
        },
      });
      return context.body(stream, 502);
    });

    const response = await app.request('http://localhost/stream');
    await response.body?.cancel();

    expect(lines[0]?.cause).toBe('y'.repeat(256));
    expect(pulled).toBeLessThanOrEqual(8);
  });

  it('names the request in a header so a client can cite it', async () => {
    const app = new Hono();
    app.use('*', observeMiddleware({ log: () => {}, now: clock(0, 1) }));
    app.get('/health', (context) => context.json({ status: 'ok' }));

    const response = await app.request('http://localhost/health');

    expect(response.headers.get('X-Request-Id')).toMatch(HEX_32);
  });

  it('names the request in the header even when the handler threw', async () => {
    const { lines, log } = collector();
    const app = new Hono();
    app.onError(onError);
    app.use('*', observeMiddleware({ log, now: clock(0, 1) }));
    app.get('/boom', () => {
      throw new Error('constraint violated');
    });

    const response = await app.request('http://localhost/boom');

    expect(response.status).toBe(500);
    expect(response.headers.get('X-Request-Id')).toMatch(HEX_32);
    expect(lines[0]?.request).toBe(response.headers.get('X-Request-Id'));
  });

  it('gives the error line and the request line the same identifier', async () => {
    const { lines, log } = collector();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = new Hono();
    app.onError(onError);
    app.use('*', observeMiddleware({ log, now: clock(0, 1) }));
    app.get('/boom', () => {
      throw new Error('constraint violated');
    });

    await app.request('http://localhost/boom');

    const [reported] = errors.mock.calls[0] ?? [];
    expect(typeof reported).toBe('string');
    const failure: unknown = JSON.parse(String(reported));
    expect(failure).toMatchObject({
      message: 'request failed',
      method: 'GET',
      path: '/boom',
      request: lines[0]?.request,
      cause: 'constraint violated',
    });
  });

  it('writes one JSON line through the default sink', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = new Hono();
    app.use('*', observeMiddleware({ now: clock(0, 42) }));
    app.get('/api/pages/abc', (context) =>
      context.json({ error: 'not_found' }, 404),
    );

    await app.request('http://localhost/api/pages/abc');

    expect(warnings).toHaveBeenCalledTimes(1);
    const [written] = warnings.mock.calls[0] ?? [];
    const line: unknown = JSON.parse(String(written));
    expect(line).toMatchObject({
      level: 'warn',
      message: 'request refused',
      method: 'GET',
      path: '/api/pages/abc',
      status: 404,
      ms: 42,
      cause: '{"error":"not_found"}',
    });
  });
});

describe('createApp observability', () => {
  it('writes nothing for a request it served', async () => {
    const consoles = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };

    const response = await createApp({ database: undefined }).request(
      'http://localhost/health',
    );

    expect(response.status).toBe(200);
    expect(consoles.log).not.toHaveBeenCalled();
    expect(consoles.info).not.toHaveBeenCalled();
    expect(consoles.warn).not.toHaveBeenCalled();
    expect(consoles.error).not.toHaveBeenCalled();
  });

  it('names every request it answers', async () => {
    const response = await createApp({ database: undefined }).request(
      'http://localhost/health',
    );

    expect(response.headers.get('X-Request-Id')).toMatch(HEX_32);
  });

  it('keeps a refusal it served', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createApp({ database: undefined }).request(
      'http://localhost/api/workspaces',
    );

    expect(errors).toHaveBeenCalledTimes(1);
    const line: unknown = JSON.parse(String(errors.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      level: 'error',
      message: 'request refused',
      path: '/api/workspaces',
      status: 503,
      cause: '{"error":"database_not_configured"}',
    });
  });
});
