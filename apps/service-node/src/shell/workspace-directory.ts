import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';
import { deliverNotificationMails, type Notice } from './notification-mail.ts';
import { inTransaction } from './bootstrap.ts';
import { loadSession, sessionDigest } from './session.ts';
import { readWorkspaceScope, readWorkspaceSession } from './workspace-scope.ts';
import { blokTicket } from '../tickets/hmac.ts';
import { consumeRate } from './request-code.ts';
import { documentAccess } from './room-tickets.ts';

export async function readBody(c: Context) {
  const value = await c.req.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HTTPException(400, { message: 'Invalid JSON' });
  return value;
}

export async function requireAccount(pool: Pick<PgPool, 'query'>, c: Context, admin = false) {
  const key = sessionDigest(c);
  const account = key && (await loadSession(pool, key));
  if (!account) throw new HTTPException(401, { message: 'Sign in required' });
  if (admin && !account.user.instanceAdmin)
    throw new HTTPException(403, { message: 'Instance administrator required' });
  return account.user;
}

const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
export function validWorkspace(slug: unknown, name: unknown) {
  return (
    typeof slug === 'string' &&
    slugPattern.test(slug) &&
    typeof name === 'string' &&
    !!name.trim() &&
    Buffer.byteLength(name) <= 120
  );
}

async function lookup(db: Pick<PoolClient, 'query'>, slug: string, digest?: string) {
  const {
    rows: [ws],
  } = await db.query(
    `SELECT w.id,w.slug,w.name,w.allow_notification_mail AS "allowNotificationMail",m.role,j.status AS "joinStatus"
    FROM workspaces w LEFT JOIN sessions s ON s.id=$2 AND s.expires_at>now()
    LEFT JOIN memberships m ON m.workspace_id=w.id AND m.user_id=s.user_id
    LEFT JOIN join_requests j ON j.workspace_id=w.id AND j.user_id=s.user_id
    WHERE w.slug=$1 OR w.id=$1 ORDER BY (w.slug=$1) DESC LIMIT 1`,
    [slug, digest ?? null],
  );
  if (!ws) throw new HTTPException(404, { message: 'Workspace not found' });
  return ws;
}

export function workspaceDirectory(pool: PgPool) {
  const router = new Hono();
  router.on('POST', ['/api/workspaces', '/api/admin/workspaces'], bodyLimit({ maxSize: 8192 }), async (c) => {
    const admin = c.req.path.startsWith('/api/admin/');
    await requireAccount(pool, c, admin);
    const { name, slug } = await readBody(c);
    if (!validWorkspace(slug, name))
      throw new HTTPException(400, { message: 'Invalid workspace name or slug' });
    const id = randomUUID();
    await inTransaction(pool, async (db) => {
      const {
        rows: [cfg],
      } = await db.query('SELECT workspace_creation FROM instance_settings WHERE id FOR UPDATE');
      const user = await requireAccount(db, c, admin);
      if (
        !admin &&
        (cfg.workspace_creation === 'disabled' ||
          (cfg.workspace_creation === 'admins_only' && !user.instanceAdmin))
      )
        throw new HTTPException(403, { message: 'Workspace creation restricted' });
      if (!(await consumeRate(db, 'workspace:' + user.id, 10)))
        throw new HTTPException(429, { message: 'Too many workspaces' });
      await db.query('INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3)', [id, slug, name]);
      await db.query("INSERT INTO memberships VALUES($1,$2,'admin')", [id, user.id]);
      await db.query(
        'UPDATE instance_settings SET default_workspace_id=$1,updated_by=$2,updated_at=now() WHERE id AND (SELECT count(*) FROM workspaces)=1',
        [id, user.id],
      );
    });
    return c.json({ id, slug, name, role: 'admin' }, 201);
  });
  router.get('/api/workspaces/:slug', async (c) =>
    c.json(await lookup(pool, c.req.param('slug'), sessionDigest(c))),
  );
  router.patch('/api/workspaces/:slug', bodyLimit({ maxSize: 8192 }), async (c) => {
    const { name, allowNotificationMail } = await readBody(c);
    // Chaque champ est facultatif, mais un corps qui ne demande rien est une
    // erreur d'appel : l'écrire quand même reviendrait à deviner l'intention.
    const renaming = name !== undefined;
    const switching = allowNotificationMail !== undefined;
    if (renaming && (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 120))
      throw new HTTPException(400, { message: 'Invalid workspace name' });
    if (switching && typeof allowNotificationMail !== 'boolean')
      throw new HTTPException(400, { message: 'Invalid e-mail setting' });
    if (!renaming && !switching) throw new HTTPException(400, { message: 'Nothing to change' });
    const result = await inTransaction(pool, async (db) => {
      const scope = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug'), true);
      if (scope.role !== 'admin') throw new HTTPException(403, { message: 'Administrator required' });
      return (
        await db.query(
          `UPDATE workspaces SET name=COALESCE($1,name), allow_notification_mail=COALESCE($2,allow_notification_mail)
           WHERE id=$3
           RETURNING id,slug,name,allow_notification_mail AS "allowNotificationMail",'admin'::text AS role`,
          [renaming ? name : null, switching ? allowNotificationMail : null, scope.workspace_id],
        )
      ).rows[0];
    });
    return c.json(result);
  });
  router.post('/api/workspaces/:slug/join-requests', bodyLimit({ maxSize: 8192 }), async (c) => {
    await requireAccount(pool, c);
    const { message = '' } = await readBody(c);
    if (typeof message !== 'string' || Buffer.byteLength(message) > 2000)
      throw new HTTPException(400, { message: 'Invalid message' });
    let mailed: {workspace: string; notices: Notice[]} | null = null;
    const status = await inTransaction(pool, async (db) => {
      const {workspace_id, user_id} = await readWorkspaceSession(db, sessionDigest(c) ?? '', c.req.param('slug'), true);
      const {rows: [prior]} = await db.query(
        `SELECT EXISTS(SELECT FROM memberships WHERE workspace_id=$1 AND user_id=$2) AS member,
          (SELECT status FROM join_requests WHERE workspace_id=$1 AND user_id=$2) AS status`,
        [workspace_id, user_id],
      );
      if (prior.member) return 'approved';
      const {rows: [submission]} = await db.query(
        `INSERT INTO join_requests(id,workspace_id,user_id,message) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,user_id)
        DO UPDATE SET message=excluded.message,status='pending',created_at=now(),
          notification_cycle=CASE WHEN join_requests.status='pending' THEN join_requests.notification_cycle ELSE excluded.notification_cycle END
        RETURNING notification_cycle`,
        [randomUUID(), workspace_id, user_id, message],
      );
      if (prior.status !== 'pending') {
        const created = await db.query<Notice>(
          `INSERT INTO workspace_notifications(workspace_id,recipient_id,actor_id,type,request_cycle)
           SELECT workspace_id,user_id,$2,'join_requested',$3 FROM memberships WHERE workspace_id=$1 AND role='admin'
           RETURNING recipient_id,type`,
          [workspace_id, user_id, submission.notification_cycle],
        );
        mailed = {workspace: workspace_id, notices: created.rows};
      }
      return 'pending';
    });
    // Après le commit seulement : un e-mail ne doit pas annoncer une écriture annulée.
    if (mailed?.notices.length) await deliverNotificationMails(pool, mailed.workspace, mailed.notices);
    return c.json({ ok: true, status });
  });
  router.get('/api/workspaces/:slug/join-requests', async (c) => {
    const requests = await inTransaction(pool, async (db) => {
      const scope = await readWorkspaceScope(db, sessionDigest(c) ?? '', c.req.param('slug'), false);
      if (scope.role !== 'admin') throw new HTTPException(403, { message: 'Administrator required' });
      return (
        await db.query(
          `SELECT j.id,j.user_id AS "userId",u.email,j.message,j.status,j.created_at AS "createdAt" FROM join_requests j
        JOIN users u ON u.id=j.user_id WHERE workspace_id=$1 ORDER BY j.created_at DESC`,
          [scope.workspace_id],
        )
      ).rows;
    });
    return c.json({ requests });
  });
  router.post('/api/workspaces/:slug/join-requests/:id/:action', bodyLimit({ maxSize: 8192 }), async (c) => {
    const { role = 'member' } = await readBody(c);
    const { slug, id, action } = c.req.param();
    if (!['approve', 'reject'].includes(action) || !['member', 'viewer'].includes(role))
      throw new HTTPException(400, { message: 'Invalid decision' });
    let mailed: {workspace: string; notices: Notice[]} | null = null;
    await inTransaction(pool, async (db) => {
      const scope = await readWorkspaceScope(db, sessionDigest(c) ?? '', slug, true);
      if (scope.role !== 'admin') throw new HTTPException(403, { message: 'Administrator required' });
      const {
        rows: [request],
      } = await db.query(
        "UPDATE join_requests SET status=$3 WHERE id=$1 AND workspace_id=$2 AND status='pending' RETURNING user_id,notification_cycle",
        [id, scope.workspace_id, action === 'approve' ? 'approved' : 'rejected'],
      );
      if (!request) throw new HTTPException(404, { message: 'Pending request not found' });
      if (action === 'approve')
        await db.query('INSERT INTO memberships VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
          scope.workspace_id,
          request.user_id,
          role,
        ]);
      const created = await db.query<Notice>(
        `INSERT INTO workspace_notifications(workspace_id,recipient_id,actor_id,type,request_cycle) VALUES($1,$2,$3,$4,$5)
         RETURNING recipient_id,type`,
        [scope.workspace_id, request.user_id, scope.user_id, action === 'approve' ? 'join_approved' : 'join_rejected',request.notification_cycle],
      );
      mailed = {workspace: scope.workspace_id, notices: created.rows};
    });
    if (mailed?.notices.length) await deliverNotificationMails(pool, mailed.workspace, mailed.notices);
    return c.json({ ok: true });
  });
  router.post('/api/workspaces/:slug/pages/:id/seed', bodyLimit({ maxSize: 8 << 20 }), async (c) => {
    const { document } = await readBody(c);
    if (!Array.isArray(document?.blocks))
      throw new HTTPException(400, { message: 'Document blocks required' });
    const { slug, id } = c.req.param();
    await inTransaction(pool, async (db) => {
      const key = sessionDigest(c) ?? '';
      const scope = await readWorkspaceScope(db, key, slug, true);
      const decision = await documentAccess(db, key, id, slug);
      if (!decision.read) throw new HTTPException(404, { message: 'Page not found' });
      if (!decision.write) throw new HTTPException(403, { message: 'Write access required' });
      const result = await db.query(
        `UPDATE pages SET content=$3 WHERE workspace_id=$1 AND id=$2 AND content IS NULL AND NOT admission_started AND version=0 AND NOT trashed AND NOT deleted`,
        [scope.workspace_id, id, JSON.stringify(document)],
      );
      if (!result.rowCount)
        throw new HTTPException(409, { message: 'Document already initialized or collaboration started' });
    });
    return c.json({ ok: true });
  });
  router.post('/api/workspaces/:slug/pages/:id/duplicate', bodyLimit({ maxSize: 16384 }), async (c) => {
    const { slug, id } = c.req.param();
    const b = await readBody(c);
    if (
      typeof b.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(b.id) ||
      typeof b.title !== 'string' ||
      Buffer.byteLength(b.title) > 4096 ||
      (b.parentId != null && typeof b.parentId !== 'string')
    )
      throw new HTTPException(400, { message: 'Invalid duplicate metadata' });
    const key = sessionDigest(c) ?? '';
    const check = async (db: PoolClient) => {
      const scope = await readWorkspaceScope(db, key, slug, true);
      if (scope.role === 'viewer') throw new HTTPException(403, { message: 'Write access required' });
      const source = await documentAccess(db, key, id, slug);
      if (!source.read) throw new HTTPException(404, { message: 'Source page not found' });
      if (b.parentId && !(await documentAccess(db, key, b.parentId, slug)).write)
        throw new HTTPException(404, { message: 'Parent page not found' });
      return { scope, source };
    };
    await inTransaction(pool, async (db) => {
      await check(db);
      await db.query('UPDATE pages SET admission_started=true WHERE id=$1', [id]);
    });
    const ticket = blokTicket(process.env.TICKET_SECRET!, {
      doc: id,
      user: key,
      write: false,
      ttlSeconds: 60,
    });
    const response = await fetch(
      new URL('/api/blok/sync/' + encodeURIComponent(id) + '/state', process.env.BLOK_ROOM_STATE_ORIGIN ?? 'http://127.0.0.1:18102'),
      {
        headers: { Authorization: 'Bearer ' + ticket, Origin: process.env.PUBLIC_URL! },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new HTTPException(503, { message: 'Could not snapshot the live source document' });
    const content = await response.text();
    const result = await inTransaction(pool, async (db) => {
      const { scope, source } = await check(db);
      // Resolve inherited visibility before a copy changes parents.
      const added = await db.query(
        `INSERT INTO pages(id,workspace_id,metadata,content,visibility)
        SELECT $1,p.workspace_id,p.metadata || jsonb_build_object('id',$1::text,'title',$2::text,'parentId',$3::text,
          'position',(SELECT count(*) FROM pages WHERE workspace_id=p.workspace_id)),
          jsonb_set($4::jsonb,'{title}',to_jsonb($2::text)),CASE WHEN p.visibility='inherit' THEN $6 ELSE p.visibility END
        FROM pages p WHERE p.id=$5 AND NOT p.trashed AND NOT p.deleted`,
        [b.id, b.title, b.parentId ?? null, content, id, source.visibility],
      );
      if (!added.rowCount) throw new HTTPException(404, { message: 'Source page not found' });
      await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,$2,'full',$2)", [
        b.id,
        scope.user_id,
      ]);
      return (
        await db.query('UPDATE workspaces SET revision=revision+1 WHERE id=$1 RETURNING revision', [
          scope.workspace_id,
        ])
      ).rows[0];
    });
    return c.json({ id: b.id, revision: Number(result.revision) }, 201);
  });
  return router;
}
