import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { HTTPException } from 'hono/http-exception';
import { WorkspaceError } from './workspace-scope.ts';
import { createHostedAi } from './hosted-ai.ts';
import { createHostedMcp } from './hosted-mcp.ts';
import { createShellAssets } from './assets.ts';
import { instanceAdmin } from './instance-admin.ts';
import { createGoogleCalendarProvider } from './google-calendar-provider.ts';
import { googleCalendarRoutes } from './google-calendar.ts';
import { calendarFeedRoutes } from './calendar-feeds.ts';
import { calendarSharing } from './calendar-sharing.ts';
import { workspaceCalendar } from './calendar.ts';
import { workspaceNotifications } from './notifications.ts';
import { markdownImportRoutes } from './markdown-import.ts';
import { workspaceDirectory } from './workspace-directory.ts';
import { registerTrashRestore } from './page-restore.ts';
import { pagePurgeRoutes, roomPurger } from './page-purge.ts';
import { roomTickets } from './room-tickets.ts';
import { createMcpTokens } from './mcp-tokens.ts';
import { createLoginMail, createRequestCode } from './request-code.ts';
import { createDeviceSessions, deviceCredential } from './device-account.ts';
import { createShellAuth } from './auth.ts';
import { registerIndexWrite } from './index-write.ts';
import type { PgPool } from '../db/pool.ts';
import { createInviteMail } from './invite-mail.ts';
import { createWorkspaceInvites } from './workspace-invites.ts';
import { createWorkspaceMembers } from './workspace-members.ts';
import { createPageSharing } from './page-sharing.ts';
import { createAccessRecheck, recheckLiveSessions } from './recheck-access.ts';
import { type ProjectionHead, readProjectionHeaders, saveProjection } from './projection.ts';
import { createWorkspaceSearch } from './workspace-search.ts';
import { createShellTeamspaces } from './teamspaces.ts';
import { loadWorkspaceIndex } from './workspace-index.ts';
import { loadSession, loadVisiblePage, sessionDigest } from './session.ts';

const digest = (input: string) => createHash('sha256').update(input).digest();

export function createShellApp(pool: PgPool, secret: string, allowedOrigins: ReadonlySet<string>, recheckAccess = createAccessRecheck(secret), inviteMail = createInviteMail(pool)) {
  if (secret.length < 32) throw new Error('INTERNAL_SECRET must have at least 32 characters');
  const expected = digest('Bearer ' + secret);
  const nodeRoomPage = process.env.BLOK_NODE_ROOM_PAGE;
  const nodeRoomWorkspace = process.env.BLOK_NODE_ROOM_WORKSPACE;
  if (nodeRoomPage && nodeRoomWorkspace) throw new Error('Select one room ownership mode');
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof HTTPException || error instanceof WorkspaceError) return context.json({error:error.message},error.status);
    if ('code' in error && error.code === '23505') return context.json({error:'Already exists'},409);
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
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Blok-Ticket, Range, If-Match, Idempotency-Key');
      c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      return c.body(null, 204);
    }
    if (!origin && !['GET', 'HEAD'].includes(c.req.method) && c.req.header('Sec-Fetch-Site') === 'cross-site') {
      return c.json({ error: 'Cross-site write refused' }, 403);
    }
    await next();
  });

  app.route('/api/mcp/tokens', createMcpTokens(pool));
  app.route('/api/auth', createRequestCode(pool, secret, createLoginMail(), process.env.TRUSTED_PROXY_CIDRS ?? ''));
  app.route('/api/auth', createShellAuth(pool, secret, () => recheckLiveSessions(secret)));
  const googleCalendar = createGoogleCalendarProvider(secret);
  app.route('/', googleCalendarRoutes(pool, googleCalendar));
  app.route('/', calendarFeedRoutes(pool, secret));
  app.route('/api/workspaces/:slug/calendar', calendarSharing(pool, (workspace, user, from, to) => googleCalendar.freeBusy(pool, workspace, user, from, to)));
  app.route('/api/workspaces/:slug/calendar', workspaceCalendar(pool));
  app.route('/api/workspaces/:slug/notifications', workspaceNotifications(pool));
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
  app.route('/mcp',createHostedMcp(pool));
  app.route('/api/workspaces/:slug/ai',createHostedAi(pool));
  app.route('/',createShellAssets(pool,secret));
  const device = deviceCredential(process.env.BLOK_DEVICE_SESSION_SECRET);
  if (device) app.post('/api/setup/claim', c => c.json({error:'Cet appareil dispose déjà de son compte local.'}, 409));
  app.route('/',instanceAdmin(pool,secret,() => recheckLiveSessions(secret)));
  app.route('/',workspaceDirectory(pool));
  app.route('/',markdownImportRoutes(pool));
  app.route('/',pagePurgeRoutes(pool,roomPurger(secret)));
  registerIndexWrite(app, pool, recheckAccess);
  registerTrashRestore(app, pool);
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
    const page = await loadVisiblePage(pool, key, c.req.param('slug'), c.req.param('id'), c.req.query('preview') === '1');
    if (!page.authenticated) return c.json({ error: 'Sign in required' }, 401);
    if (!page.workspace) return c.json({ error: 'Workspace not found' }, 404);
    if (!page.member) return c.json({ error: 'Workspace membership required' }, 403);
    if (page.content === null) return c.json({ error: 'Page not found' }, 404);
    return c.body(page.content, 200, { 'Content-Type': 'application/json' });
  });

  app.route('/api/workspaces/:slug/invites', createWorkspaceInvites(pool, inviteMail));
  app.route('/api/workspaces/:slug/members', createWorkspaceMembers(pool, recheckAccess));
  app.route('/api/workspaces/:slug/pages', createPageSharing(pool, recheckAccess));

  if (device) {
    const expectedDevice = digest('Bearer ' + device);
    const getSession = createDeviceSessions(pool);
    app.post('/internal/desktop/session', async c => {
      if (c.req.header('Origin') || !timingSafeEqual(expectedDevice, digest(c.req.header('Authorization') ?? ''))) {
        return c.json({error: 'Native authorization required'}, 403);
      }
      return c.json(await getSession());
    });
  }
  app.use('/internal/*', async (c, next) => {
    if (!timingSafeEqual(expected, digest(c.req.header('Authorization') ?? ''))) {
      return c.json({ error: 'Internal authorization required' }, 401);
    }
    await next();
  });
  const ticketSecret = process.env.TICKET_SECRET;
  if (ticketSecret) app.route('/', roomTickets(pool, ticketSecret));
  app.get('/internal/documents/:id', async (c) => {
    const { rows } = await pool.query<ProjectionHead & { content: string }>(
      "SELECT coalesce(content::text,'null') AS content, version::text, lineage, sequence::text FROM pages WHERE id=$1 AND NOT deleted", [c.req.param('id')],
    );
    const row = rows[0];
    if (!row) return c.json({ error: 'Document not found' }, 404);
    // Keep jsonb numbers intact instead of round-tripping user data through JS floats.
    c.header('Blok-Doc-Version', row.version);
    if (row.lineage !== null && row.sequence !== null) {
      c.header('Blok-Doc-Lineage', row.lineage);
      c.header('Blok-Doc-Sequence', row.sequence);
    }
    const { content, ...metadata } = row;
    const payload = `{"data":${content},"version":${JSON.stringify(metadata.version)},"lineage":${JSON.stringify(metadata.lineage)},"sequence":${JSON.stringify(metadata.sequence)}}`;
    return c.body(payload, 200, { 'Content-Type': 'application/json' });
  });
  app.put('/internal/documents/:id', bodyLimit({ maxSize: 64 * 1024 * 1024, onError: (c) => c.json({ error: 'Document too large' }, 413) }), async (c) => {
    const head = readProjectionHeaders(c.req.raw.headers);
    if (!head) return c.json({ error: 'Invalid projection headers' }, 400);
    if ((process.env.BLOK_NODE_ROOM_ALL === '1' || nodeRoomPage && c.req.param('id') === nodeRoomPage) && !head.expected) {
      return c.json({ error: 'Node room requires an exact projection head' }, 409);
    }
    const json = await c.req.text();
    try {
      JSON.parse(json);
    } catch {
      return c.json({ error: 'Invalid document' }, 400);
    }
    const version = await saveProjection(pool, c.req.param('id'), json, head, nodeRoomWorkspace);
    if (version === undefined) return c.json({ error: 'Document missing or projection stale' }, 409);
    return c.json({ version });
  });
  return app;
}
