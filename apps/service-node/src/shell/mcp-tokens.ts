import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { generateSessionToken, hashSecret } from '../auth/codes.ts';
import type { PgPool } from '../db/pool.ts';
import { sessionDigest } from './session.ts';

type Account = {Variables: {userId: string}};
type Token = {id: string; label: string; createdAt: Date; expiresAt: Date};
const fields = 'id, label, created_at AS "createdAt", expires_at AS "expiresAt"';

// Keep the same hourly counter as Go. Locking it through commit also serializes
// concurrent creates for this owner before they count active tokens.
async function changeToken(pool: PgPool, userId: string, target: {label: string} | {id: string}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows: [rate]} = await client.query<{count: number}>(`
      INSERT INTO email_rate_limits(key,count) VALUES($1,1)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN email_rate_limits.window_start<now()-interval '1 hour' THEN 1 ELSE email_rate_limits.count+1 END,
        window_start=CASE WHEN email_rate_limits.window_start<now()-interval '1 hour' THEN now() ELSE email_rate_limits.window_start END
      RETURNING count`, ['mcp-token:'+userId]);
    if (rate!.count > 10) {
      await client.query('COMMIT');
      return {status:429, body:{error:'id' in target ? 'Too many token changes' : 'Too many tokens created'}} as const;
    }
    const token = generateSessionToken();
    const id = hashSecret(token);
    let issued: Token | undefined;
    if ('label' in target) {
      const count = await client.query<{full: boolean}>(
        'SELECT count(*)>=10 AS full FROM mcp_tokens WHERE user_id=$1 AND expires_at>now()', [userId]);
      if (count.rows[0]!.full) {
        await client.query('COMMIT');
        return {status:409, body:{error:'Revoke an existing token first'}} as const;
      }
      issued = (await client.query<Token>(
        `INSERT INTO mcp_tokens(id,user_id,label,expires_at) VALUES($1,$2,$3,now()+interval '90 days') RETURNING ${fields}`,
        [id,userId,target.label])).rows[0];
    } else {
      issued = (await client.query<Token>(
        `UPDATE mcp_tokens SET id=$1,created_at=now(),expires_at=now()+interval '90 days',last_used_at=NULL
         WHERE id=$2 AND user_id=$3 AND expires_at>now() RETURNING ${fields}`, [id,target.id,userId])).rows[0];
    }
    await client.query('COMMIT');
    if (!issued) return {status:404,body:{error:'Token not found'}} as const;
    return {status:'label' in target ? 201 : 200, body:{...issued,token}} as const;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function createMcpTokens(pool: PgPool) {
  const routes = new Hono<Account>();
  routes.use('*', async (c, next) => {
    const digest = sessionDigest(c);
    if (!digest) return c.json({error:'Sign in required'}, 401);
    const {rows:[session]} = await pool.query<{user_id:string}>(
      'SELECT user_id FROM sessions WHERE id=$1 AND expires_at>now()', [digest]);
    if (!session) return c.json({error:'Sign in required'}, 401);
    c.set('userId',session.user_id);
    await next();
  });
  routes.get('/', async c => {
    const {rows} = await pool.query<Token & {lastUsedAt: Date | null}>(
      `SELECT ${fields},last_used_at AS "lastUsedAt" FROM mcp_tokens
       WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC`, [c.get('userId')]);
    return c.json({tokens:rows});
  });
  routes.post('/', bodyLimit({maxSize:8<<20, onError:c=>c.json({error:'Invalid JSON'},400)}), async c => {
    let input: unknown;
    try { input = await c.req.json(); } catch { return c.json({error:'Invalid JSON'},400); }
    if (input !== null && (typeof input !== 'object' || Array.isArray(input))) return c.json({error:'Invalid JSON'},400);
    // Go's JSON decoder accepts case-insensitive struct field names and keeps the last match.
    const raw = Object.entries(input ?? {}).filter(([key]) => key.toLowerCase() === 'label').at(-1)?.[1];
    if (raw != null && typeof raw !== 'string') return c.json({error:'Invalid JSON'},400);
    const label = (raw ?? '').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    if (!label || Buffer.byteLength(label)>80) return c.json({error:'Invalid token name'},400);
    const result = await changeToken(pool,c.get('userId'),{label});
    return c.json(result.body,result.status);
  });
  routes.post('/:id/rotate', async c => {
    const result = await changeToken(pool,c.get('userId'),{id:c.req.param('id')});
    return c.json(result.body,result.status);
  });
  routes.delete('/:id', async c => {
    const {rowCount} = await pool.query('DELETE FROM mcp_tokens WHERE id=$1 AND user_id=$2',[c.req.param('id'),c.get('userId')]);
    return rowCount ? c.json({ok:true}) : c.json({error:'Token not found'},404);
  });
  return routes;
}
