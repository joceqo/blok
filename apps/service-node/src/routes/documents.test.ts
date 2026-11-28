import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

import type { SessionVariables } from '../middleware/session.ts';
import { verifyBlokTicket } from '../tickets/hmac.ts';

const forwardToSidecar = vi.hoisted(() => vi.fn(async () => new Response('ok', { status: 200 })));

vi.mock('../sidecar/client.ts', () => ({
  forwardToSidecar,
  sidecarNotConfiguredResponse: () =>
    Response.json({ error: 'sidecar_not_configured' }, { status: 503 }),
  buildSidecarUrl: () => 'http://127.0.0.1:4000/sync/doc-1/state',
}));

import { createDocumentsRoutes } from './documents.ts';

type Env = { Variables: SessionVariables };

const SECRET = 'test-secret-at-least-32-characters!';

describe('GET /api/documents/:docId/state', () => {
  beforeEach(() => {
    process.env.BLOK_SECRET = SECRET;
    process.env.BLOK_SIDECAR_URL = 'http://127.0.0.1:4000';
    forwardToSidecar.mockClear();
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function appWithUser(userId: string | undefined): Hono<Env> {
    const app = new Hono<Env>();
    app.use('*', async (context, next) => {
      if (userId !== undefined) {
        context.set('userId', userId);
      }
      await next();
    });
    app.route('/', createDocumentsRoutes());
    return app;
  }

  it('mints Authorization when the session is set and the client sent none', async () => {
    const app = appWithUser('user-1');
    const response = await app.request('http://localhost/api/documents/doc-abc/state');

    expect(response.status).toBe(200);
    expect(forwardToSidecar).toHaveBeenCalledTimes(1);

    const [, request] = forwardToSidecar.mock.calls[0] ?? [];
    expect(request).toBeInstanceOf(Request);
    const auth = (request as Request).headers.get('authorization');
    expect(auth?.startsWith('Bearer ')).toBe(true);
    const token = auth?.slice('Bearer '.length) ?? '';
    expect(verifyBlokTicket(SECRET, token)).toMatchObject({
      user: 'user-1',
      doc: 'doc-abc',
      write: false,
    });
  });

  it('does not replace a client Authorization header', async () => {
    const app = appWithUser('user-1');
    const response = await app.request('http://localhost/api/documents/doc-abc/state', {
      headers: { authorization: 'Bearer client-token' },
    });

    expect(response.status).toBe(200);
    const [, request] = forwardToSidecar.mock.calls[0] ?? [];
    expect((request as Request).headers.get('authorization')).toBe('Bearer client-token');
  });

  it('forwards without Authorization when there is no session', async () => {
    const app = appWithUser(undefined);
    await app.request('http://localhost/api/documents/doc-abc/state');

    const [, request] = forwardToSidecar.mock.calls[0] ?? [];
    expect((request as Request).headers.get('authorization')).toBeNull();
  });
});