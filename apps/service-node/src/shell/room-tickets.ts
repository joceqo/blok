import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';
import { blokTicket } from '../tickets/hmac.ts';
import { roomPass } from '../tickets/room-pass.ts';
import { canEditPage, resolvePageLevel, type Role, type Visibility } from './page-level.ts';
import { sessionDigest } from './session.ts';

interface Decision {
  authenticated: boolean;
  workspace: string | null;
  role: Role | null;
  visible: boolean;
  visibility: Visibility;
  highest: number;
}

// Each live check reads the session, page, its inherited ACL and workspace role
// at a single PostgreSQL snapshot. The optional route slug resolves before the
// membership filter. Constrain every ancestor to this workspace.
async function access(db: Pick<PoolClient, 'query'>, session: string, doc: string, slug?: string) {
  const {
    rows: [decision],
  } = await db.query<Decision>(
    `WITH RECURSIVE account AS (
       SELECT user_id FROM sessions WHERE id=$1 AND expires_at>now()
     ), workspace AS (
       SELECT id FROM workspaces WHERE $3::text IS NOT NULL AND (slug=$3 OR id=$3)
       UNION ALL SELECT workspace_id FROM pages WHERE $3::text IS NULL AND id=$2
     ), scope AS (
       SELECT w.id FROM workspace w JOIN workspaces d ON d.id=w.id ORDER BY (d.slug=$3) DESC LIMIT 1
     ), member AS (
       SELECT m.user_id,m.role,m.workspace_id FROM memberships m JOIN account a USING(user_id)
       JOIN scope w ON w.id=m.workspace_id
     ), chain AS (
       SELECT p.id,p.workspace_id,p.visibility,nullif(p.metadata->>'parentId','') AS parent,0 AS depth
       FROM pages p JOIN member m ON m.workspace_id=p.workspace_id
       WHERE p.id=$2 AND NOT p.trashed AND NOT p.deleted
       UNION ALL
       SELECT p.id,p.workspace_id,p.visibility,nullif(p.metadata->>'parentId',''),c.depth+1
       FROM pages p JOIN chain c ON p.id=c.parent AND p.workspace_id=c.workspace_id
       WHERE c.depth+1<64 AND NOT p.deleted
     )
     SELECT EXISTS(SELECT FROM account) AS authenticated, (SELECT id FROM scope) AS workspace,
       (SELECT role FROM member) AS role, EXISTS(SELECT FROM chain) AS visible,
       coalesce((SELECT visibility FROM chain WHERE visibility<>'inherit' ORDER BY depth LIMIT 1),'private') AS visibility,
       coalesce((SELECT max(array_position(ARRAY['view','edit','full'],s.level)-1)
         FROM page_shares s JOIN chain c ON c.id=s.page_id JOIN account a USING(user_id)),-1) AS highest`,
    [session, doc, slug ?? null],
  );
  if (!decision) throw new Error('Missing document authorization decision');
  const level =
    decision.visible && decision.role
      ? resolvePageLevel(decision.role, decision.visibility, decision.highest)
      : undefined;
  return { ...decision, read: !!level, write: canEditPage(level) };
}

export function roomTickets(pool: PgPool, ticketSecret: string) {
  if (ticketSecret.length < 32) throw new Error('TICKET_SECRET must have at least 32 characters');
  const router = new Hono();
  async function mint(c: Context) {
    c.header('X-Blok-Ticket-Backend', 'node');
    const session = sessionDigest(c);
    if (!session) return c.json({ error: 'Sign in required' }, 401);
    const doc = c.req.query('doc') ?? '';
    const slug = c.req.param('slug');
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const decision = await access(client, session, doc, slug);
      if (!decision.authenticated) return c.json({ error: 'Sign in required' }, 401);
      if (slug && !decision.workspace) return c.json({ error: 'Workspace not found' }, 404);
      if (slug && !decision.role) return c.json({ error: 'Workspace membership required' }, 403);
      if (!decision.read)
        return slug
          ? c.json({ error: 'Page not found' }, 404)
          : c.json({ error: 'Document access refused' }, 403);
      const marked = await client.query(
        'UPDATE pages SET admission_started=true WHERE id=$1 AND workspace_id=$2 AND NOT trashed AND NOT deleted',
        [doc, decision.workspace],
      );
      if (!marked.rowCount)
        return slug
          ? c.json({ error: 'Page not found' }, 404)
          : c.json({ error: 'Document access refused' }, 403);
      const ticket = blokTicket(ticketSecret, { user: session, doc, write: decision.write, ttlSeconds: 60 });
      await client.query('COMMIT');
      committed = true;
      return c.json({ ticket });
    } finally {
      try {
        if (!committed) await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
  }
  router.get('/api/blok-ticket', mint);
  router.get('/api/workspaces/:slug/ticket', mint);
  router.post(
    '/internal/room-access',
    bodyLimit({ maxSize: 8 << 20, onError: (c) => c.json({ error: 'Invalid JSON' }, 400) }),
    async (c) => {
      c.header('X-Blok-Access-Backend', 'node');
      const input = await c.req.json().catch(() => undefined);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return c.json({ error: 'Invalid JSON' }, 400);
      const { documentId, ticket, session } = input;
      if (
        typeof documentId !== 'string' ||
        !documentId ||
        (ticket != null && typeof ticket !== 'string') ||
        (session != null && typeof session !== 'string') ||
        !!ticket === !!session
      ) {
        return c.json({ error: 'Specify a ticket or a session and one document' }, 400);
      }
      const claims = ticket ? roomPass(ticketSecret, ticket, documentId) : undefined;
      if (ticket && !claims) return c.json({ error: 'Valid document ticket required' }, 401);
      const digest: string = claims?.user ?? session;
      if (!/^[a-fA-F0-9]{64}$/.test(digest))
        return c.json({ error: 'Invalid room authorization request' }, 400);
      const decision = await access(pool, digest, documentId);
      if (!decision.read) return c.json({ read: false, write: false });
      if (claims)
        return c.json({
          read: true,
          write: decision.write && claims.write,
          workspaceId: decision.workspace,
          session: digest,
          ticketWrite: claims.write,
        });
      return c.json({ read: true, write: decision.write, workspaceId: decision.workspace });
    },
  );
  return router;
}
