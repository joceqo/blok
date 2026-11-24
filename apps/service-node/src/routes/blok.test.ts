import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '@/app.js';
import { syncWebSocketHint } from '@/routes/blok.js';

const forwardToSidecar = vi.hoisted(() => vi.fn(async () => new Response('ok', { status: 200 })));

vi.mock('@/sidecar/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sidecar/client.js')>();
  return {
    ...actual,
    forwardToSidecar,
  };
});

describe('GET /api/blok/unfurl', () => {
  let savedSidecarUrl: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedSidecarUrl = process.env.BLOK_SIDECAR_URL;
    process.env.BLOK_SIDECAR_URL = 'http://127.0.0.1:4000';
  });

  afterEach(() => {
    if (savedSidecarUrl === undefined) {
      delete process.env.BLOK_SIDECAR_URL;
    } else {
      process.env.BLOK_SIDECAR_URL = savedSidecarUrl;
    }
  });

  it('proxies to the sidecar /unfurl with passThroughHeaders', async () => {
    const app = createApp({ database: undefined });
    const target = 'https://example.com/page';
    await app.request(`http://localhost/api/blok/unfurl?url=${encodeURIComponent(target)}`, {
      headers: { cookie: 'session=abc', authorization: 'Bearer ticket' },
    });

    expect(forwardToSidecar).toHaveBeenCalledWith(
      '/unfurl',
      expect.any(Request),
      expect.any(URL),
      { passThroughHeaders: true },
    );
    const [, request, url] = forwardToSidecar.mock.calls[0] ?? [];
    expect(url?.searchParams.get('url')).toBe(target);
    expect((request as Request).headers.get('cookie')).toBe('session=abc');
    expect((request as Request).headers.get('authorization')).toBe('Bearer ticket');
  });

  it('returns 503 when BLOK_SIDECAR_URL is unset', async () => {
    const { forwardToSidecar: realForward } =
      await vi.importActual<typeof import('@/sidecar/client.js')>('@/sidecar/client.js');
    forwardToSidecar.mockImplementation(realForward);
    delete process.env.BLOK_SIDECAR_URL;

    const app = createApp({ database: undefined });
    const response = await app.request(
      'http://localhost/api/blok/unfurl?url=https%3A%2F%2Fexample.com',
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'sidecar_not_configured',
      hint: 'Set BLOK_SIDECAR_URL to the blok-server base (e.g. http://127.0.0.1:4000)',
    });
  });
});

describe('GET /api/blok/sync/:docId', () => {
  let savedSidecarUrl: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedSidecarUrl = process.env.BLOK_SIDECAR_URL;
    process.env.BLOK_SIDECAR_URL = 'http://127.0.0.1:4000';
  });

  afterEach(() => {
    if (savedSidecarUrl === undefined) {
      delete process.env.BLOK_SIDECAR_URL;
    } else {
      process.env.BLOK_SIDECAR_URL = savedSidecarUrl;
    }
  });

  it('returns 501 upgrade_required for a plain HTTP GET', async () => {
    const app = createApp({ database: undefined });
    const response = await app.request('http://localhost/api/blok/sync/doc-1');

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: 'upgrade_required',
      hint: syncWebSocketHint('doc-1'),
    });
    expect(forwardToSidecar).not.toHaveBeenCalled();
  });

  it('returns 501 with a ws hint when the client sends Upgrade: websocket', async () => {
    const app = createApp({ database: undefined });
    const response = await app.request('http://localhost/api/blok/sync/doc-1', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: 'upgrade_required',
      hint: 'Connect to the sidecar WebSocket at ws://127.0.0.1:4000/sync/doc-1',
    });
    expect(forwardToSidecar).not.toHaveBeenCalled();
  });

  it('still proxies nested sync paths such as /state', async () => {
    const app = createApp({ database: undefined });
    await app.request('http://localhost/api/blok/sync/doc-1/state');

    expect(forwardToSidecar).toHaveBeenCalledWith(
      '/sync/doc-1/state',
      expect.any(Request),
      expect.any(URL),
    );
  });
});

describe('syncWebSocketHint', () => {
  let savedSidecarUrl: string | undefined;

  beforeEach(() => {
    savedSidecarUrl = process.env.BLOK_SIDECAR_URL;
  });

  afterEach(() => {
    if (savedSidecarUrl === undefined) {
      delete process.env.BLOK_SIDECAR_URL;
    } else {
      process.env.BLOK_SIDECAR_URL = savedSidecarUrl;
    }
  });

  it('mentions BLOK_SIDECAR_URL when the sidecar base is unset', () => {
    delete process.env.BLOK_SIDECAR_URL;
    expect(syncWebSocketHint('notes')).toContain('BLOK_SIDECAR_URL');
    expect(syncWebSocketHint('notes')).toContain('/sync/notes');
  });
});