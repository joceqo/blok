import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { pageDocuments, pages } from '../db/schema.ts';
import type { DbVariables } from '../middleware/db.ts';
import { requireUser } from '../middleware/require-user.ts';
import type { SessionVariables } from '../middleware/session.ts';
import { canMintTicketForDoc } from '../tickets/can-mint-ticket-for-doc.ts';
import { blokTicket } from '../tickets/hmac.ts';
import { memberRole } from '../workspaces/membership.ts';

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

  if (doc !== undefined) {
    const db = context.get('db');
    const binding = (
      await db
        .select({ workspaceId: pages.workspaceId })
        .from(pageDocuments)
        .innerJoin(pages, eq(pageDocuments.pageId, pages.id))
        .where(eq(pageDocuments.docId, doc))
        .limit(1)
    )[0];

    const role =
      binding === undefined ? undefined : await memberRole(db, userId, binding.workspaceId);

    const gate = canMintTicketForDoc({
      hasBinding: binding !== undefined,
      role,
      write,
    });

    if (!gate.ok) {
      if (gate.reason === 'permission_denied') {
        return context.json({ error: 'permission_denied' }, 403);
      }
      return context.json({ error: gate.reason }, 404);
    }
  }

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