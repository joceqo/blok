import { BlockList, isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgPool } from '../db/pool.ts';
import { generateLoginCode, hashSecret } from '../auth/codes.ts';

import { createInternalMailTransport } from './internal-mail.ts';

export interface LoginMail {
  normalize(email: string): Promise<string | undefined>;
  deliver(email: string, code: string): Promise<void>;
}

export function createLoginMail(secret: string): LoginMail {
  const post = createInternalMailTransport(secret);
  return {
    async normalize(email) {
      const response = await post('/internal/invitations/normalize', { email });
      if (response.status === 400) return;
      if (!response.ok) throw new Error('Address validation unavailable');
      const data = await response.json() as {email?: string};
      if (!data.email) throw new Error('Invalid address validation response');
      return data.email;
    },
    async deliver(email, code) {
      const response = await post('/internal/auth/login-mail', { email, code });
      if (response.status !== 204) throw new Error('Email delivery unavailable');
    },
  };
}

function canonicalIP(input: string): string | undefined {
  if (isIP(input) === 4) return input;
  if (isIP(input) !== 6 || input.includes('%')) return;
  const address = new URL('http://[' + input + ']').hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(address);
  if (!mapped) return address;
  const n = parseInt(mapped[1]!,16) * 65536 + parseInt(mapped[2]!,16);
  return [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.');
}

export function trustedClientIP(cidrs: string) {
  const allowed = new BlockList();
  for (const raw of cidrs.split(',').map(s => s.trim()).filter(Boolean)) {
    const [address, bits] = raw.split('/');
    const family = isIP(address ?? '');
    if (!family || !bits || !/^\d+$/.test(bits)) throw new Error('Invalid trusted proxy CIDR');
    allowed.addSubnet(address!, Number(bits), family === 4 ? 'ipv4' : 'ipv6');
  }
  return (peer: string, forwarded: string): string => {
    const origin = canonicalIP(peer) ?? peer;
    let current = origin;
    for (const hop of forwarded.split(',').reverse()) {
      if (!isIP(current) || !allowed.check(current, isIP(current) === 4 ? 'ipv4' : 'ipv6')) break;
      const next = canonicalIP(hop.trim());
      if (!next) break;
      current = next;
    }
    return current;
  };
}

export function createRequestCode(pool: PgPool, secret: string, mail: LoginMail, trusted: string) {
  const router = new Hono();
  const clientIP = trustedClientIP(trusted);
  const rate = async (key: string, max: number) => {
    const result = await pool.query<{ count: number }>(`INSERT INTO email_rate_limits(key,count) VALUES ($1,1)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN email_rate_limits.window_start<now()-interval '1 hour'
        THEN 1 ELSE email_rate_limits.count+1 END, window_start=CASE WHEN email_rate_limits.window_start<now()-interval '1 hour'
        THEN now() ELSE email_rate_limits.window_start END RETURNING count`, [key]);
    return result.rows[0]!.count <= max;
  };
  router.post('/request-code', bodyLimit({ maxSize: 8192 }), async c => {
    const input = await c.req.json().catch(() => null);
    if (typeof input?.email !== 'string' || !input.email.trim()) return c.json({ error:'Invalid email' },400);
    const email = await mail.normalize(input.email);
    if (!email) return c.json({ error:'Invalid email' },400);
    const ip = clientIP(getConnInfo(c).remote.address ?? 'unknown', c.req.header('X-Forwarded-For') ?? '');
    const limited = () => c.json({ error:'Too many attempts; try again later' },429);
    if (!await rate('login-ip:'+ip,30) || !await rate('login-email:'+email,8)) return limited();
    const { rowCount } = await pool.query(`SELECT 1 WHERE EXISTS (SELECT FROM users WHERE email=$1)
      OR EXISTS (SELECT FROM invites WHERE email=$1 AND status='pending' AND expires_at>now())
      OR EXISTS (SELECT FROM instance_settings WHERE id AND (signup_policy='open' OR
        (signup_policy='domain' AND EXISTS (SELECT FROM unnest(signup_domains) domain WHERE lower(trim(domain))=$2))))`,
      [email,email.slice(email.lastIndexOf('@')+1)]);
    if (!rowCount) return c.json({ ok:true });
    const code = generateLoginCode();
    const digest = hashSecret(email + ':' + code + ':' + secret);
    const saved = await pool.query(`INSERT INTO login_codes(email,digest,expires_at)
        VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT(email) DO UPDATE SET
        digest=excluded.digest,expires_at=excluded.expires_at,attempts=0,sent_at=now()
        WHERE login_codes.sent_at<now()-interval '45 seconds' RETURNING email`, [email,digest]);
    if (!saved.rowCount) return limited();
    try {
      await mail.deliver(email,code);
    } catch {
      await pool.query('DELETE FROM login_codes WHERE email=$1 AND digest=$2', [email,digest]);
      return c.json({ error:'Email delivery unavailable' },503);
    }
    return c.json({ ok:true });
  });
  return router;
}
