import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { PgPool } from '../db/pool.js';

export function sessionDigest(context: Context): string | undefined {
  const auth = context.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : getCookie(context, 'blok_session');
  return token ? createHash('sha256').update(token).digest('hex') : undefined;
}

// Read all session fields from one PostgreSQL snapshot, including role changes.
export async function loadSession(pool: PgPool, digest: string) {
  return (await pool.query(
    `SELECT jsonb_build_object('id',u.id,'email',u.email,'name',u.name,
                               'instanceAdmin',ia.user_id IS NOT NULL) AS "user",
            coalesce((SELECT jsonb_agg(jsonb_build_object('id',w.id,'slug',w.slug,'name',w.name,
                                                          'role',m.role) ORDER BY w.name,w.id)
                      FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
                      WHERE m.user_id=u.id),'[]') AS workspaces,
            coalesce((SELECT a.email FROM instance_admins i JOIN users a ON a.id=i.user_id
                      ORDER BY i.created_at,a.email LIMIT 1),'') AS "supportEmail"
     FROM sessions s JOIN users u ON u.id=s.user_id
     LEFT JOIN instance_admins ia ON ia.user_id=u.id
     WHERE s.id=$1 AND s.expires_at>now()`, [digest],
  )).rows[0];
}

// Match Go's nearest explicit visibility plus any named share on the first 64
// ancestors. Membership, session expiry, ACL and payload are read in one snapshot.
export async function loadVisiblePage(pool: PgPool, digest: string, slug: string, id: string) {
  const { rows } = await pool.query<{ authenticated: boolean; workspace: boolean; member: boolean; content: string | null }>(
    `WITH RECURSIVE account AS (SELECT user_id FROM sessions WHERE id=$1 AND expires_at>now()),
     workspace AS (SELECT id FROM workspaces WHERE slug=$2 OR id=$2 ORDER BY (slug=$2) DESC LIMIT 1),
     member AS (SELECT m.* FROM memberships m JOIN workspace w ON w.id=m.workspace_id
                JOIN account a ON a.user_id=m.user_id),
     chain AS (
       SELECT p.id,p.visibility,p.metadata->>'parentId' AS parent,0 AS depth FROM pages p
       JOIN member m ON m.workspace_id=p.workspace_id WHERE p.id=$3 AND NOT p.deleted
       UNION ALL
       SELECT p.id,p.visibility,p.metadata->>'parentId',c.depth+1 FROM pages p
       JOIN chain c ON c.parent=p.id JOIN member m ON m.workspace_id=p.workspace_id
       WHERE NOT p.deleted AND c.depth+1<64
     ),
     visible AS (
       SELECT coalesce((SELECT visibility='workspace' FROM chain WHERE visibility<>'inherit'
                        ORDER BY depth LIMIT 1),false)
              OR EXISTS(SELECT 1 FROM chain c JOIN page_shares sh ON sh.page_id=c.id
                        JOIN account a ON a.user_id=sh.user_id
                        WHERE sh.level IN ('view','edit','full')) AS allowed
     )
     SELECT EXISTS(SELECT FROM account) AS authenticated, EXISTS(SELECT FROM workspace) AS workspace,
            EXISTS(SELECT FROM member) AS member,
            (SELECT coalesce(p.content::text,'null') FROM pages p JOIN chain c ON c.id=p.id AND c.depth=0
             WHERE (SELECT allowed FROM visible)) AS content`, [digest, slug, id],
  );
  return rows[0]!;
}
