import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());

vi.stubGlobal('fetch', fetchMock);

import { createInstanceRoutes } from './instance.js';

describe('GET /api/instance', () => {
  let savedSidecarUrl: string | undefined;

  beforeEach(() => {
    savedSidecarUrl = process.env.BLOK_SIDECAR_URL;
    delete process.env.BLOK_SIDECAR_URL;
    fetchMock.mockReset();
  });

  afterEach(() => {
    if (savedSidecarUrl === undefined) {
      delete process.env.BLOK_SIDECAR_URL;
    } else {
      process.env.BLOK_SIDECAR_URL = savedSidecarUrl;
    }
  });

  function app() {
    const routes = new Hono();
    routes.route('/', createInstanceRoutes({ database: undefined }));
    return routes;
  }

  it('omits sidecarReachable when BLOK_SIDECAR_URL is unset', async () => {
    const response = await app().request('http://localhost/api/instance');
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    expect(body.sidecar).toBe(false);
    expect(body).not.toHaveProperty('sidecarReachable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes sidecarReachable true when the sidecar health check succeeds', async () => {
    process.env.BLOK_SIDECAR_URL = 'http://127.0.0.1:4000';
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    const response = await app().request('http://localhost/api/instance');
    expect(response.status).toBe(200);
    const body: { sidecar: boolean; sidecarReachable: boolean } = await response.json();
    expect(body.sidecar).toBe(true);
    expect(body.sidecarReachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/health',
      expect.objectContaining({
        method: 'GET',
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it('includes sidecarReachable false when the health check errors', async () => {
    process.env.BLOK_SIDECAR_URL = 'http://127.0.0.1:4000';
    fetchMock.mockRejectedValue(new Error('connection refused'));

    const response = await app().request('http://localhost/api/instance');
    const body: { sidecarReachable: boolean } = await response.json();
    expect(body.sidecarReachable).toBe(false);
  });

  it('includes sidecarReachable false when health returns a non-OK status', async () => {
    process.env.BLOK_SIDECAR_URL = 'http://127.0.0.1:4000';
    fetchMock.mockResolvedValue(new Response('down', { status: 503 }));

    const response = await app().request('http://localhost/api/instance');
    const body: { sidecarReachable: boolean } = await response.json();
    expect(body.sidecarReachable).toBe(false);
  });
});