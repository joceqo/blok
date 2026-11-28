import { createHmac, timingSafeEqual } from 'node:crypto';
import { assetKey, isAssetKey, mediaOrigin, removeAssetFile } from './asset-storage.ts';
export { assetKey } from './asset-storage.ts';
import { Hono, type Context } from 'hono';
import type { PgPool } from '../db/pool.ts';
import { verifyBlokTicket } from '../tickets/hmac.ts';
import { roomPass } from '../tickets/room-pass.ts';
import { documentAccess } from './room-tickets.ts';
import { sessionDigest } from './session.ts';
import { createWorkspaceMedia } from './workspace-media.ts';

function grant(secret: string, session: string, name: string, expires: string) {
  return createHmac('sha256', secret)
    .update(session + '\n' + name + '\n' + expires)
    .digest();
}

export function verifyAssetGrant(
  query: URLSearchParams,
  secret: string,
  name: string,
  now = Math.floor(Date.now() / 1000),
) {
  const session = query.get('session') ?? '';
  const expires = query.get('expires') ?? '';
  const raw = query.get('grant') ?? '';
  if (!/^[a-f0-9]{64}$/.test(session) || !/^\d{1,15}$/.test(expires) || !/^[A-Za-z0-9_-]{43}$/.test(raw))
    return;
  if (Number(expires) < now || Number(expires) > now + 65) return;
  if (timingSafeEqual(Buffer.from(raw, 'base64url'), grant(secret, session, name, expires))) return session;
}

async function permitted(pool: PgPool, session: string, name: string) {
  const {
    rows: [asset],
  } = await pool.query<{ document_id: string | null; workspace_id: string }>(
    `SELECT a.document_id,a.workspace_id FROM assets a JOIN memberships m ON m.workspace_id=a.workspace_id
     JOIN sessions s ON s.user_id=m.user_id AND s.id=$2 AND s.expires_at>now() WHERE a.name=$1`,
    [name, session],
  );
  if (!asset) return false;
  if (asset.document_id === null) return true;
  const decision = await documentAccess(pool, session, asset.document_id);
  return decision.read && decision.workspace === asset.workspace_id;
}

const forwarded = ['content-type', 'range', 'if-range', 'if-modified-since', 'if-unmodified-since'] as const;
function proxy(mediaHost: string, c: Context, path: string, publicURL: string, ticket?: string) {
  const headers = new Headers();
  for (const key of forwarded) {
    const value = c.req.header(key);
    if (value) headers.set(key, value);
  }
  if (ticket) {
    headers.set('Authorization', 'Bearer ' + ticket);
    // The shell middleware has already verified the browser's origin.
    headers.set('Origin', new URL(publicURL).origin);
  }
  const init: RequestInit & { duplex?: 'half' } = {
    method: c.req.method,
    headers,
    redirect: 'error',
    signal: c.req.raw.signal,
  };
  if (c.req.raw.body) {
    init.body = c.req.raw.body;
    init.duplex = 'half';
  }
  return fetch(mediaHost + path, init);
}

function privateResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.delete('access-control-allow-origin');
  headers.delete('connection');
  headers.delete('transfer-encoding');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Security-Policy', 'sandbox');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, headers });
}

export function createShellAssets(pool: PgPool, secret: string, mediaHost = mediaOrigin) {
  const app = new Hono();
  const publicURL = process.env.PUBLIC_URL || 'http://localhost:8080';
  const ticketSecret = process.env.TICKET_SECRET ?? '';
  app.route('/', createWorkspaceMedia(pool, mediaHost));
  app.get('/api/assets/url', async (c) => {
    const session = sessionDigest(c);
    if (
      !session ||
      !(await pool.query('SELECT 1 FROM sessions WHERE id=$1 AND expires_at>now()', [session])).rowCount
    )
      return c.json({ error: 'Sign in required' }, 401);
    const raw = c.req.query('url') ?? '';
    let url;
    try {
      url = new URL(raw, publicURL);
    } catch {
      return c.json({ error: 'Invalid asset URL' }, 400);
    }
    if (url.origin !== new URL(publicURL).origin)
      return c.json({ error: 'Asset must belong to this server' }, 400);
    const name = assetKey(raw, publicURL);
    if (!name || !(await permitted(pool, session, name)))
      return c.json({ error: 'Asset access refused' }, 403);
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    const signed = new URL('/files/' + name, publicURL);
    signed.search = new URLSearchParams({
      session,
      expires,
      grant: grant(secret, session, name, expires).toString('base64url'),
    }).toString();
    return c.json({ url: signed.href });
  });
  app.all('/files/:name', async (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD')
      return c.json({ error: 'Method not allowed' }, 405);
    const name = c.req.param('name');
    if (!isAssetKey(name)) return c.json({ error: 'Asset not found' }, 404);
    let session = sessionDigest(c);
    if (
      !session ||
      !(await pool.query('SELECT 1 FROM sessions WHERE id=$1 AND expires_at>now()', [session])).rowCount
    ) {
      session = verifyAssetGrant(new URL(c.req.url).searchParams, secret, name);
      if (!session) return c.json({ error: 'Asset authorization required' }, 401);
    }
    if (!(await permitted(pool, session, name))) return c.json({ error: 'Asset access refused' }, 403);
    return privateResponse(await proxy(mediaHost, c, '/files/' + name, publicURL));
  });
  app.all('/api/blok/:action{upload|upload-by-url|delete|unfurl|frame-check|file-bytes}', async (c) => {
    const action = c.req.param('action');
    const token =
      c.req.query('ticket') ||
      c.req.header('X-Blok-Ticket') ||
      c.req.header('Authorization')?.replace(/^Bearer /, '') ||
      '';
    let doc;
    if (ticketSecret)
      try {
        doc = verifyBlokTicket(ticketSecret, token).doc;
      } catch {
        /* Invalid ticket. */
      }
    const claims = doc && roomPass(ticketSecret, token, doc);
    if (!doc || !claims) return c.json({ error: 'Valid document ticket required' }, 401);
    const access = await documentAccess(pool, claims.user, doc);
    if (!access.read || (!['GET', 'HEAD'].includes(c.req.method) && !(claims.write && access.write)))
      return c.json({ error: 'Document access refused' }, 403);
    if (action === 'delete') return c.json({ error: 'Assets are retained for document history' }, 405);
    const query = new URL(c.req.url).searchParams;
    query.delete('ticket');
    const target = query.get('url') ?? '';
    if (action === 'file-bytes') {
      const name = assetKey(target, publicURL);
      if (name && !(await permitted(pool, claims.user, name)))
        return c.json({ error: 'Asset access refused' }, 403);
    }
    const media = await proxy(mediaHost, c, '/' + action + '?' + query.toString(), publicURL, token);
    if (!media.ok || (action !== 'upload' && action !== 'upload-by-url')) return privateResponse(media);
    const result = (await media.json()) as { url: string };
    const name = assetKey(result.url, publicURL);
    if (!name) throw new Error('Invalid private upload response');
    // Re-check after a slow upload, under the same lock as workspace sharing changes.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [access.workspace]);
      const current = await documentAccess(client, claims.user, doc);
      if (!current.write || current.workspace !== access.workspace) {
        await client.query('ROLLBACK');
        await removeAssetFile(name, mediaHost);
        return c.json({ error: 'Document access refused' }, 403);
      }
      await client.query('INSERT INTO assets(name,workspace_id,document_id) VALUES($1,$2,$3)', [
        name,
        current.workspace,
        doc,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (!(await client.query('SELECT 1 FROM assets WHERE name=$1', [name])).rowCount)
        await removeAssetFile(name, mediaHost);
      throw error;
    } finally {
      client.release();
    }
    return c.json(result);
  });
  return app;
}
