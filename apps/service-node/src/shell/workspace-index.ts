import type { PgPool } from '../db/pool.js';

export type Role = 'admin' | 'member' | 'viewer';
type Level = 'view' | 'edit' | 'full';
type Visibility = 'private' | 'workspace';

export interface IndexPage {
  id: string;
  metadata: { parentId?: string | null; [key: string]: unknown };
  trashed: boolean;
  visibility: Visibility | 'inherit';
  share: Level | null;
  shared: boolean;
}

interface Standing {
  level: Level;
  visibility: Visibility;
  shared: boolean;
  sharedRoot?: true;
}

const levels: Level[] = ['view', 'edit', 'full'];

// These are the same chains, role ceiling and sidebar labels used by Go's
// workspaceStandings. Build them from metadata alone, never document bodies.
export function workspaceIndex(rows: IndexPage[], role: Role, revision: number) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const access: Record<string, Standing> = Object.create(null);
  for (const page of rows) {
    let first: Visibility | undefined;
    let visibility: Visibility = 'private';
    let shared = false;
    let granted = -1;
    let node: IndexPage | undefined = page;
    for (let depth = 0; node && depth < 64; depth++) {
      if (node.visibility !== 'inherit') {
        first ??= node.visibility;
        // Match the presentation hint on the Go index, independently of access.
        if (visibility === 'private') visibility = node.visibility;
      }
      shared ||= node.shared;
      if (node.share !== null) granted = Math.max(granted, levels.indexOf(node.share));
      node = node.metadata.parentId ? byId.get(node.metadata.parentId) : undefined;
    }
    if (first === 'workspace') {
      const base = role === 'admin' ? 'full' : role === 'member' ? 'edit' : 'view';
      granted = Math.max(granted, levels.indexOf(base));
    }
    if (role === 'viewer') granted = Math.min(granted, 0);
    const level = levels[granted];
    if (level) access[page.id] = { level, visibility, shared };
  }
  const pages: IndexPage['metadata'][] = [];
  const trash: IndexPage['metadata'][] = [];
  for (const page of rows) {
    const standing = access[page.id];
    if (!standing) continue;
    let meta = page.metadata;
    if (meta.parentId && !access[meta.parentId]) {
      meta = { ...meta, parentId: null };
      standing.sharedRoot = true;
    }
    (page.trashed ? trash : pages).push(meta);
  }
  return { pages, trash, revision, access };
}

export async function loadIndexPages(client: Pick<PgPool, 'query'>, workspaceId: string, userId: string) {
  return (await client.query<IndexPage>(
      `SELECT p.id,p.metadata,p.trashed,p.visibility,mine.level AS share,
              EXISTS(SELECT 1 FROM page_shares s WHERE s.page_id=p.id AND s.user_id<>$2) AS shared
       FROM pages p LEFT JOIN page_shares mine ON mine.page_id=p.id AND mine.user_id=$2
       WHERE p.workspace_id=$1 AND NOT p.deleted
       ORDER BY (p.metadata->>'position')::numeric NULLS LAST,p.id`, [workspaceId, userId],
  )).rows;
}

export async function loadWorkspaceIndex(pool: PgPool, digest: string, slug: string) {
  const client = await pool.connect();
  try {
    // The revision and page tree must belong to the same snapshot. Otherwise
    // an old tree paired with a newer revision could overwrite another client.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: [scope] } = await client.query<{
      user_id: string | null; workspace_id: string | null; role: Role | null; revision: string;
    }>(`SELECT a.user_id, w.id AS workspace_id, w.revision::text, m.role
        FROM (SELECT 1) start
        LEFT JOIN sessions a ON a.id=$1 AND a.expires_at>now()
        LEFT JOIN workspaces w ON w.slug=$2
        LEFT JOIN memberships m ON m.user_id=a.user_id AND m.workspace_id=w.id`, [digest, slug]);
    if (!scope?.user_id || !scope.workspace_id || !scope.role) {
      await client.query('COMMIT');
      if (!scope?.user_id) return { status: 401, error: 'Sign in required' } as const;
      if (!scope.workspace_id) return { status: 404, error: 'Workspace not found' } as const;
      return { status: 403, error: 'Workspace membership required' } as const;
    }
    const rows = await loadIndexPages(client, scope.workspace_id, scope.user_id);
    await client.query('COMMIT');
    const revision = Number(scope.revision);
    if (!Number.isSafeInteger(revision)) throw new Error('Workspace revision cannot be represented in the shell');
    return { status: 200, data: workspaceIndex(rows, scope.role, revision) } as const;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
