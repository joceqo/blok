import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { sessionDigest } from './session.ts';
import { readWorkspaceSession } from './workspace-scope.ts';

// Both reads and acknowledgments recheck the recipient's current admin role.
// A rejected applicant can still read their own decision outside the workspace.
const visibleToRecipient = `n.workspace_id=$1 AND n.recipient_id=$2 AND (
  n.type <> 'join_requested' OR EXISTS (
    SELECT FROM memberships m WHERE m.workspace_id=n.workspace_id AND m.user_id=n.recipient_id AND m.role='admin'
  )
)`;

export function workspaceNotifications(pool: PgPool) {
  const router = new Hono();
  router.get('/', async c => {
    const result = await inTransaction(pool, async db => {
      const {workspace_id, user_id} = await readWorkspaceSession(db, sessionDigest(c) ?? '', c.req.param('slug')!, false);
      const {rows} = await db.query(
        `SELECT n.id,n.type,n.created_at AS "createdAt",n.read_at AS "readAt",
           coalesce(nullif(u.name,''), CASE WHEN n.type='join_requested' THEN u.email ELSE 'Un administrateur' END) AS "actorName",
           (count(*) FILTER (WHERE n.read_at IS NULL) OVER ())::int AS unread
         FROM workspace_notifications n JOIN users u ON u.id=n.actor_id
         WHERE ${visibleToRecipient}
         ORDER BY (n.read_at IS NULL) DESC,n.created_at DESC,n.id DESC LIMIT 50`,
        [workspace_id, user_id],
      );
      return {
        notifications: rows.map(({ id, type, createdAt, readAt, actorName }) => ({ id, type, createdAt, readAt, actorName })),
        unreadCount: rows[0]?.unread ?? 0,
      };
    });
    return c.json(result);
  });
  router.post('/:id/read', async c => {
    await inTransaction(pool, async db => {
      const {workspace_id, user_id} = await readWorkspaceSession(db, sessionDigest(c) ?? '', c.req.param('slug')!, true);
      const result = await db.query(
        `UPDATE workspace_notifications n SET read_at=coalesce(n.read_at,now()) WHERE ${visibleToRecipient} AND n.id=$3`,
        [workspace_id, user_id, c.req.param('id')],
      );
      if (!result.rowCount) throw new HTTPException(404, {message:'Notification not found'});
    });
    return c.json({ok:true});
  });
  return router;
}
