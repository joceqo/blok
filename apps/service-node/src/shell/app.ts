import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { createMcpTokens } from './mcp-tokens.ts';
import { createShellAuth } from './auth.js';
import { registerIndexWrite } from './index-write.js';
import type { PgPool } from '../db/pool.js';
import { createWorkspaceMembers } from './workspace-members.js';
import { createPageSharing } from './page-sharing.js';
import { createAccessRecheck, recheckLiveSessions } from './recheck-access.js';
import { readProjectionHeaders, saveProjection } from './projection.js';
import { createWorkspaceSearch } from './workspace-search.js';
import { createShellTeamspaces } from './teamspaces.js';
import { loadWorkspaceIndex } from './workspace-index.js';
import { loadSession, loadVisiblePage, sessionDigest } from './session.js';

const digest = (input: string) => createHash('sha256').update(input).digest();

export function createShellApp(pool: PgPool, secret: string, allowedOrigins: ReadonlySet<string>, recheckAccess = createAccessRecheck(secret)) {
  if (secret.length < 32) throw new Error('INTERNAL_SECRET must have at least 32 characters');
  const expected = digest('Bearer ' + secret);
  const app = new Hono();
  app.onError((error, context) => {
    console.error('[shell-backend]', error.name);
    return context.json({ error: 'Database unavailable' }, 503);
  });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('Origin');
    c.header('Vary', 'Origin');
    if (origin) {
      if (!allowedOrigins.has(origin)) return c.json({ error: 'Origin refused' }, 403);
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      return c.body(null, 204);
    }
    if (!origin && !['GET', 'HEAD'].includes(c.req.method) && c.req.header('Sec-Fetch-Site') === 'cross-site') {
      return c.json({ error: 'Cross-site write refused' }, 403);
    }
    await next();
  });

  app.route('/api/mcp/tokens', createMcpTokens(pool));
  app.route('/api/auth', createShellAuth(pool, secret, () => recheckLiveSessions(secret)));
  app.route('/api/workspaces/:slug/search', createWorkspaceSearch(pool));
  app.route('/api/workspaces/:slug/teamspaces', createShellTeamspaces(pool));

  app.get('/healthz', async (c) => {
    await pool.query('SELECT 1');
    return c.json({ ok: true });
  });
  app.on('GET', ['/api/session', '/api/workspaces'], async (c) => {
    const key = sessionDigest(c);
    const session = key && await loadSession(pool, key);
    if (!session) return c.json({ error: 'Sign in required' }, 401);
    return c.json(c.req.path === '/api/session' ? session : { workspaces: session.workspaces });
  });
  registerIndexWrite(app, pool, recheckAccess);
  app.get('/api/workspaces/:slug/index', async (c) => {
    const key = sessionDigest(c);
    if (!key) return c.json({ error: 'Sign in required' }, 401);
    const result = await loadWorkspaceIndex(pool, key, c.req.param('slug'));
    if (result.status !== 200) return c.json({ error: result.error }, result.status);
    return c.json(result.data);
  });
  app.get('/api/workspaces/:slug/pages/:id', async (c) => {
    const key = sessionDigest(c);
    if (!key) return c.json({ error: 'Sign in required' }, 401);
    const page = await loadVisiblePage(pool, key, c.req.param('slug'), c.req.param('id'));
    if (!page.authenticated) return c.json({ error: 'Sign in required' }, 401);
    if (!page.workspace) return c.json({ error: 'Workspace not found' }, 404);
    if (!page.member) return c.json({ error: 'Workspace membership required' }, 403);
    if (page.content === null) return c.json({ error: 'Page not found' }, 404);
    return c.body(page.content, 200, { 'Content-Type': 'application/json' });
  });

  app.route('/api/workspaces/:slug/members', createWorkspaceMembers(pool, recheckAccess));
  app.route('/api/workspaces/:slug/pages', createPageSharing(pool, recheckAccess));

  app.use('/internal/documents/*', async (c, next) => {
    if (!timingSafeEqual(expected, digest(c.req.header('Authorization') ?? ''))) {
      return c.json({ error: 'Internal authorization required' }, 401);
    }
    await next();
  });
  app.get('/internal/documents/:id', async (c) => {
    const { rows } = await pool.query<{ content: string; version: string }>(
      "SELECT coalesce(content::text,'null') AS content, version::text FROM pages WHERE id=$1", [c.req.param('id')],
    );
    const row = rows[0];
    if (!row) return c.json({ error: 'Document not found' }, 404);
    // Keep jsonb numbers intact instead of round-tripping user data through JS floats.
    return c.body(`{"data":${row.content},"version":${JSON.stringify(row.version)}}`, 200, { 'Content-Type': 'application/json' });
  });
  app.put('/internal/documents/:id', bodyLimit({ maxSize: 64 * 1024 * 1024, onError: (c) => c.json({ error: 'Document too large' }, 413) }), async (c) => {
    const head = readProjectionHeaders(c.req.raw.headers);
    if (!head) return c.json({ error: 'Invalid projection headers' }, 400);
    const json = await c.req.text();
    try {
      JSON.parse(json);
    } catch {
      return c.json({ error: 'Invalid document' }, 400);
    }
    const version = await saveProjection(pool, c.req.param('id'), json, head);
    if (version === undefined) return c.json({ error: 'Document missing or projection stale' }, 409);
    return c.json({ version });
  });
  return app;
}
