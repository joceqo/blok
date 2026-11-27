import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PgPool } from '../db/pool.ts';
import { createShellApp } from './app.ts';

const secret = 's'.repeat(32);
const HEX_32 = /^[0-9a-f]{32}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shell backend observability', () => {
  const unused = {} as PgPool;

  it('names every request it answers', async () => {
    const app = createShellApp(unused, secret, new Set());

    const response = await app.request('/api/session');

    expect(response.headers.get('X-Request-Id')).toMatch(HEX_32);
  });

  it('keeps a refusal, with the reason and the request it belongs to', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createShellApp(unused, secret, new Set());

    const response = await app.request('/api/session');

    expect(warnings).toHaveBeenCalledTimes(1);
    const line: unknown = JSON.parse(String(warnings.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      level: 'warn',
      message: 'request refused',
      method: 'GET',
      path: '/api/session',
      status: 401,
      request: response.headers.get('X-Request-Id'),
      cause: '{"error":"Sign in required"}',
    });
  });

  it('gives a failure the identifier of the request that caused it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { query: () => Promise.reject(new Error('connection refused')) } as unknown as PgPool;
    const app = createShellApp(broken, secret, new Set());

    const response = await app.request('/healthz');

    expect(response.status).toBe(503);
    expect(errors).toHaveBeenCalled();
    const line: unknown = JSON.parse(String(errors.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      message: 'request failed',
      path: '/healthz',
      request: response.headers.get('X-Request-Id'),
    });
  });
});
