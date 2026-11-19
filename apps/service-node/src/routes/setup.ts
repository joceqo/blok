import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';

import {
  SESSION_COOKIE,
  generateSessionToken,
  hashSecret,
  isValidEmail,
  normalizeEmail,
  sessionExpiresAt,
} from '@/auth/codes.js';
import { findOrCreateUserByEmail } from '@/auth/users.js';
import { sessions } from '@/db/schema.js';
import type { DbVariables } from '@/middleware/db.js';
import { canRunFirstAdminSetup, needsSetup } from '@/setup/status.js';
import { countUsers } from '@/setup/user-count.js';

type Env = { Variables: DbVariables };

function lookupSetupToken(): string | undefined {
  const value = process.env.SETUP_TOKEN;
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value;
}

export function createSetupRoutes(): Hono<Env> {
  const setupRoutes = new Hono<Env>();

  setupRoutes.get('/api/setup/status', async (context) => {
    const db = context.get('db');
    const userCount = await countUsers(db);
    return context.json({ needsSetup: needsSetup(userCount) });
  });

  setupRoutes.post('/api/setup/first-admin', async (context) => {
    const db = context.get('db');
    const body: { email?: string; token?: string; createSession?: boolean } = await context.req
      .json<{ email?: string; token?: string; createSession?: boolean }>()
      .catch(() => ({}));

    const userCount = await countUsers(db);
    const bodyToken = typeof body.token === 'string' ? body.token : undefined;
    if (!canRunFirstAdminSetup(userCount, lookupSetupToken(), bodyToken)) {
      return context.json({ error: 'setup_not_allowed' }, 403);
    }

    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    if (!isValidEmail(email)) {
      return context.json({ error: 'invalid_email' }, 400);
    }

    const user = await findOrCreateUserByEmail(db, email);
    if (user === undefined) {
      return context.json({ error: 'user_create_failed' }, 500);
    }

    const createSession = body.createSession !== false;
    if (createSession) {
      const token = generateSessionToken();
      const session = (
        await db
          .insert(sessions)
          .values({
            userId: user.id,
            tokenHash: hashSecret(token),
            expiresAt: sessionExpiresAt(),
          })
          .returning()
      )[0];
      if (session === undefined) {
        return context.json({ error: 'session_create_failed' }, 500);
      }

      setCookie(context, SESSION_COOKIE, token, {
        httpOnly: true,
        path: '/',
        sameSite: 'Lax',
        secure: process.env.COOKIE_SECURE === '1',
        maxAge: 30 * 24 * 60 * 60,
      });
    }

    return context.json({
      ok: true,
      user: { id: user.id, email: user.email },
      needsSetup: false,
    });
  });

  return setupRoutes;
}