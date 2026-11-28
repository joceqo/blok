import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { sessionDigest } from './session.ts';
import { loadIndexPages, pageStandings } from './workspace-index.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';

export function registerTrashRestore(app: Hono, pool: PgPool) {
  app.post('/api/workspaces/:slug/pages/:id/restore-from-trash', bodyLimit({maxSize:2048}), async c => {
    const digest = sessionDigest(c);
    if (!digest) throw new WorkspaceError(401, 'Sign in required');
    const body = await c.req.json().catch(() => null);
    if (!Number.isSafeInteger(body?.revision) || body.revision < 0) {
      throw new WorkspaceError(400, 'Workspace revision required');
    }
    const {slug, id} = c.req.param();
    const revision = await inTransaction(pool, async db => {
      const scope = await readWorkspaceScope(db, digest, slug, true);
      if (scope.role === 'viewer') throw new WorkspaceError(403, 'Full page access required');
      const rows = await loadIndexPages(db, scope.workspace_id, scope.user_id);
      const byId = new Map(rows.map(row => [row.id, row]));
      const access = pageStandings(rows, scope.role);
      const page = byId.get(id);
      if (!page || !access[id]) throw new WorkspaceError(404, 'Page not found');
      if (access[id].level !== 'full') throw new WorkspaceError(403, 'Full page access required');
      if (!page.trashed) throw new WorkspaceError(409, 'La page n’est plus dans la corbeille.');

      // GET /index detaches visible shares from invisible ancestors. Check the
      // original hierarchy and never reparent a restored page into a wider scope.
      const seen = new Set([id]);
      let parentId = page.metadata.parentId;
      while (parentId) {
        const parent = byId.get(parentId);
        if (!parent || !access[parentId] || seen.has(parentId)) {
          throw new WorkspaceError(409, 'L’emplacement d’origine est indisponible.');
        }
        if (parent.trashed) throw new WorkspaceError(409, 'Restaurez d’abord la page parente.');
        seen.add(parentId);
        parentId = parent.metadata.parentId;
      }
      // Deletion has no batch identifier. Only the selected trash entry may
      // return. An inconsistent live child must not reappear as a side effect.
      if (rows.some(child => child.metadata.parentId === id && !child.trashed)) {
        throw new WorkspaceError(409, 'La hiérarchie de la page a changé.');
      }
      const advanced = await db.query(
        'UPDATE workspaces SET revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING revision',
        [scope.workspace_id, body.revision],
      );
      if (!advanced.rowCount) throw new WorkspaceError(409, 'L’espace a changé. Actualisez la corbeille.');
      await db.query('UPDATE pages SET trashed=false WHERE id=$1 AND workspace_id=$2', [id, scope.workspace_id]);
      return Number(advanced.rows[0].revision);
    });
    return c.json({restored:id, revision});
  });
}
