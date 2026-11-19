import { Hono } from 'hono';

/**
 * Auth (email code, sessions) — stubs until parity harness exists.
 * Go oracle: `apps/service` auth package.
 */
export const authRoutes = new Hono();

authRoutes.post('/api/auth/request-code', async (context) => {
  const body: { email?: string } = await context.req.json<{ email?: string }>().catch(() => ({}));
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email.length === 0 || !email.includes('@')) {
    return context.json({ error: 'invalid_email' }, 400);
  }
  // TODO: persist challenge, send via SMTP using config.mailerHost
  return context.json({ ok: true, delivered: false, reason: 'not_implemented' });
});

authRoutes.post('/api/auth/verify-code', async (context) => {
  const body: { email?: string; code?: string } = await context.req
    .json<{ email?: string; code?: string }>()
    .catch(() => ({}));
  if (body.code === undefined || body.email === undefined) {
    return context.json({ error: 'invalid_request' }, 400);
  }
  return context.json({ error: 'not_implemented' }, 501);
});