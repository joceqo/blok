import { eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';

import {
  SESSION_COOKIE,
  challengeExpiresAt,
  generateLoginCode,
  generateSessionToken,
  hashSecret,
  isValidEmail,
  normalizeEmail,
  sessionExpiresAt,
} from '@/auth/codes.js';
import { toUserJson } from '@/auth/serialize-user.js';
import { findOrCreateUserByEmail } from '@/auth/users.js';
import { authChallenges, sessions, users } from '@/db/schema.js';
import { sendAuthCode } from '@/mail/smtp.js';
import type { DbVariables } from '@/middleware/db.js';
import type { SessionVariables } from '@/middleware/session.js';

type Env = { Variables: DbVariables & SessionVariables };

const exposeCode =
  process.env.DEV_EXPOSE_AUTH_CODE === '1' || process.env.NODE_ENV === 'development';

export function createAuthRoutes(): Hono<Env> {
  const authRoutes = new Hono<Env>();

  authRoutes.post('/api/auth/request-code', async (context) => {
    const db = context.get('db');
    const body: { email?: string } = await context.req.json<{ email?: string }>().catch(() => ({}));
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    if (!isValidEmail(email)) {
      return context.json({ error: 'invalid_email' }, 400);
    }

    const code = generateLoginCode();
    const expiresAt = challengeExpiresAt();

    await db
      .insert(authChallenges)
      .values({ email, codeHash: hashSecret(code), expiresAt })
      .onConflictDoUpdate({
        target: authChallenges.email,
        set: { codeHash: hashSecret(code), expiresAt },
      });

    const mail = await sendAuthCode(email, code);

    const payload: Record<string, unknown> = { ok: true, delivered: mail.sent };
    if (exposeCode) {
      payload.devCode = code;
    }

    return context.json(payload);
  });

  authRoutes.post('/api/auth/verify-code', async (context) => {
    const db = context.get('db');
    const body: { email?: string; code?: string } = await context.req
      .json<{ email?: string; code?: string }>()
      .catch(() => ({}));
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!isValidEmail(email) || code.length === 0) {
      return context.json({ error: 'invalid_request' }, 400);
    }

    const now = new Date();
    const rows = await db
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.email, email))
      .limit(1);
    const challenge = rows[0];
    if (
      challenge === undefined ||
      challenge.expiresAt <= now ||
      challenge.codeHash !== hashSecret(code)
    ) {
      return context.json({ error: 'invalid_code' }, 401);
    }

    await db.delete(authChallenges).where(eq(authChallenges.email, email));

    const user = await findOrCreateUserByEmail(db, email);
    if (user === undefined) {
      return context.json({ error: 'user_create_failed' }, 500);
    }

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

    return context.json({ ok: true, user: { id: user.id, email: user.email } });
  });

  authRoutes.post('/api/auth/logout', async (context) => {
    const db = context.get('db');
    const token = context.req.raw.headers.get('cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
    if (token !== undefined) {
      await db.delete(sessions).where(eq(sessions.tokenHash, hashSecret(token)));
    }
    deleteCookie(context, SESSION_COOKIE, { path: '/' });
    return context.json({ ok: true });
  });

  authRoutes.get('/api/auth/me', async (context) => {
    const userId = context.get('userId');
    if (userId === undefined) {
      return context.json({ error: 'unauthenticated' }, 401);
    }
    const db = context.get('db');
    const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (user === undefined) {
      return context.json({ error: 'not_found' }, 404);
    }
    return context.json({ user: toUserJson(user) });
  });

  return authRoutes;
}