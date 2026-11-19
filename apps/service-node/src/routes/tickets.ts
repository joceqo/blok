import { Hono } from 'hono';

import { blokTicket } from '../tickets/blok.js';
import type { DbVariables } from '../middleware/db.js';
import { requireUser } from '../middleware/require-user.js';
import type { SessionVariables } from '../middleware/session.js';

type Env = { Variables: DbVariables & SessionVariables };

function blokSecret(): string | undefined {
  const secret = process.env.BLOK_SECRET;
  if (secret === undefined || secret.length === 0) {
    return undefined;
  }
  return secret;
}

/**
 * Mints sidecar collaboration passes for the logged-in user (`POST /api/tickets/blok`).
 */
export const ticketRoutes = new Hono<Env>();

ticketRoutes.post('/api/tickets/blok', requireUser(), async (context) => {
  const secret = blokSecret();
  if (secret === undefined) {
    return context.json({ error: 'blok_secret_not_configured' }, 503);
  }

  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const body: { doc?: string; write?: boolean; ttlSeconds?: number } = await context.req
    .json<{ doc?: string; write?: boolean; ttlSeconds?: number }>()
    .catch(() => ({}));

  const doc = typeof body.doc === 'string' && body.doc.length > 0 ? body.doc : undefined;
  const write = body.write === true;
  const ttlSeconds =
    typeof body.ttlSeconds === 'number' && Number.isInteger(body.ttlSeconds) && body.ttlSeconds > 0
      ? body.ttlSeconds
      : undefined;

  try {
    const ticket = blokTicket(secret, {
      user: userId,
      doc,
      write,
      ttlSeconds,
    });
    return context.json({ ticket });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ticket_failed';
    return context.json({ error: message }, 400);
  }
});