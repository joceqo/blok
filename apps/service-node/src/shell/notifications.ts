import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type {PoolClient} from 'pg';
import {loadIndexPages, pageStandings, type Role} from './workspace-index.ts';
import type { PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { sessionDigest } from './session.ts';
import { readWorkspaceSession } from './workspace-scope.ts';

// Reads and mutations recheck the recipient's current admin role.
// A rejected applicant can still read their own decision outside the workspace.
const visibleToRecipient = `n.workspace_id=$1 AND n.recipient_id=$2 AND (
  n.type <> 'join_requested' OR EXISTS (
    SELECT FROM memberships m WHERE m.workspace_id=n.workspace_id AND m.user_id=n.recipient_id AND m.role='admin'
  )
) AND (n.page_id IS NULL OR n.page_id=ANY($3::text[]))`;

async function pageAccess(db: PoolClient, workspace: string, user: string): Promise<string[]> {
  const {rows: [member]} = await db.query<{role: Role}>(`SELECT m.role FROM memberships m
    WHERE m.workspace_id=$1 AND m.user_id=$2 AND EXISTS (SELECT FROM workspace_notifications n
    WHERE n.workspace_id=$1 AND n.recipient_id=$2 AND n.page_id IS NOT NULL)`, [workspace,user]);
  if (!member) return [];
  const pages = await loadIndexPages(db,workspace,user);
  const access = pageStandings(pages,member.role);
  return pages.filter(page => access[page.id] && !page.trashed).map(page => page.id);
}

export function workspaceNotifications(pool: PgPool) {
  const router = new Hono();
  router.get('/', async c => {
    const result = await inTransaction(pool, async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const {workspace_id, user_id} = await readWorkspaceSession(db, sessionDigest(c) ?? '', c.req.param('slug')!, false);
      const {rows} = await db.query(
        `WITH visible AS NOT MATERIALIZED (
           SELECT n.* FROM workspace_notifications n WHERE ${visibleToRecipient}
         ), totals AS (
           SELECT count(*)::int AS unread FROM visible WHERE archived_at IS NULL AND read_at IS NULL
         ), page AS (
           SELECT * FROM visible WHERE (archived_at IS NOT NULL)=$4
           ORDER BY (read_at IS NULL) DESC,created_at DESC,id DESC LIMIT 50
         )
         SELECT n.id,n.type,n.created_at AS "createdAt",n.read_at AS "readAt",n.archived_at AS "archivedAt",
           n.page_id AS "pageId",p.metadata->>'title' AS "pageTitle",totals.unread,w.name AS "workspaceName",nullif(j.message,'') AS "requestMessage",
           (j.status='pending') AS "requestPending",
           coalesce(nullif(u.name,''), CASE WHEN n.type='join_requested' THEN u.email WHEN n.page_id IS NOT NULL THEN '' ELSE 'Un administrateur' END) AS "actorName",
           CASE WHEN d.id IS NOT NULL THEN jsonb_build_object(
             'status', CASE WHEN d.type='join_approved' THEN 'approved' ELSE 'rejected' END,
             'actorName',coalesce(nullif(reviewer.name,''),'Un administrateur'),
             'isMe',d.actor_id=n.recipient_id,'at',d.created_at
           ) END AS decision
         FROM totals LEFT JOIN page n ON TRUE
         LEFT JOIN pages p ON p.id=n.page_id
         LEFT JOIN users u ON u.id=n.actor_id
         LEFT JOIN workspaces w ON w.id=n.workspace_id
         LEFT JOIN join_requests j ON n.type='join_requested' AND j.workspace_id=n.workspace_id
           AND j.user_id=n.actor_id AND j.notification_cycle=n.request_cycle
         LEFT JOIN workspace_notifications d ON n.type='join_requested' AND d.workspace_id=n.workspace_id
           AND d.request_cycle=n.request_cycle AND d.recipient_id=n.actor_id AND d.type IN ('join_approved','join_rejected')
         LEFT JOIN users reviewer ON reviewer.id=d.actor_id
         ORDER BY (n.read_at IS NULL) DESC,n.created_at DESC,n.id DESC`,
        [workspace_id, user_id, await pageAccess(db,workspace_id,user_id), c.req.query('archived') === '1'],
      );
      return {
        notifications: rows.filter(row => row.id !== null).map(({ unread, decision, requestMessage, requestPending, pageId, pageTitle, ...notification }) => ({
          ...notification,
          ...(pageId && {pageId, pageTitle}),
          ...(decision && { decision }),
          ...(requestMessage && { requestMessage }),
          ...(requestPending !== null && { requestPending }),
        })),
        unreadCount: rows[0].unread,
      };
    });
    return c.json(result);
  });
  router.post('/read-all', async c => {
    await inTransaction(pool, async db => {
      const {workspace_id, user_id} = await readWorkspaceSession(db, sessionDigest(c) ?? '', c.req.param('slug')!, true);
      await db.query(
        `UPDATE workspace_notifications n SET read_at=now() WHERE ${visibleToRecipient} AND n.read_at IS NULL AND n.archived_at IS NULL`,
        [workspace_id, user_id, await pageAccess(db,workspace_id,user_id)],
      );
    });
    return c.json({ok:true});
  });
  const updates = {
    read: 'read_at=coalesce(n.read_at,now())',
    unread: 'read_at=NULL',
    archive: 'archived_at=coalesce(n.archived_at,now())',
    unarchive: 'archived_at=NULL',
  };
  for (const [action, assignment] of Object.entries(updates)) {
    router.post(`/:id/${action}`, async c => {
      await inTransaction(pool, async db => {
        const {workspace_id, user_id} = await readWorkspaceSession(db, sessionDigest(c) ?? '', c.req.param('slug')!, true);
        const result = await db.query(
          `UPDATE workspace_notifications n SET ${assignment} WHERE ${visibleToRecipient} AND n.id=$4`,
          [workspace_id, user_id, await pageAccess(db,workspace_id,user_id), c.req.param('id')],
        );
        if (!result.rowCount) throw new HTTPException(404, {message:'Notification not found'});
      });
      return c.json({ok:true});
    });
  }
  return router;
}
