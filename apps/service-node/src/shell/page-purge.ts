import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { sessionDigest } from './session.ts';
import { readWorkspaceScope } from './workspace-scope.ts';
import { loadIndexPages, pageStandings } from './workspace-index.ts';

export function roomPurger(secret: string) {
  return async (pageId: string) => {
    const url = new URL('http://127.0.0.1:18102/internal/room/purge');
    url.searchParams.set('documentId', pageId);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 204) throw new Error('Room purge pending (' + response.status + ')');
  };
}

type Purger = (id: string) => Promise<void>;

// The committed SQL tombstone fences off the old projection. Only the room can
// confirm that its disk tombstone is durable. Both halves tolerate a retry.
export async function finishPagePurge(pool: PgPool, id: string, purgeRoom: Purger) {
  const claim = await pool.query(
    `UPDATE page_purge_requests SET next_attempt_at=now()+interval '30 seconds'
    WHERE page_id=$1 AND completed_at IS NULL AND next_attempt_at<=now() RETURNING page_id`,
    [id],
  );
  if (!claim.rowCount) {
    return !!(
      await pool.query('SELECT 1 FROM page_purge_requests WHERE page_id=$1 AND completed_at IS NOT NULL', [
        id,
      ])
    ).rowCount;
  }
  try {
    await purgeRoom(id);
  } catch {
    return false;
  }
  await inTransaction(pool, async (db) => {
    const cleared = await db.query(
      `UPDATE pages SET content=NULL, metadata='{}', lineage=NULL, sequence=NULL
      WHERE id=$1 AND deleted RETURNING id`,
      [id],
    );
    if (!cleared.rowCount) throw new Error('Page tombstone missing');
    await db.query('DELETE FROM page_shares WHERE page_id=$1', [id]);
    await db.query('DELETE FROM teamspace_pages WHERE page_id=$1', [id]);
    await db.query(
      'UPDATE page_purge_requests SET completed_at=coalesce(completed_at,now()) WHERE page_id=$1',
      [id],
    );
  });
  return true;
}

export function pagePurgeRoutes(pool: PgPool, purgeRoom: Purger) {
  const app = new Hono();
  app.delete('/api/workspaces/:slug/pages/:id/purge', async (c) => {
    const { slug, id } = c.req.param();
    const digest = sessionDigest(c);
    if (!digest) throw new HTTPException(401, { message: 'Sign in required' });
    const completed = await inTransaction(pool, async (db) => {
      const scope = await readWorkspaceScope(db, digest, slug, true);
      if (scope.role === 'viewer') throw new HTTPException(403, { message: 'Full page access required' });
      const {
        rows: [page],
      } = await db.query(
        `SELECT p.deleted,p.trashed,r.requested_by,r.completed_at FROM pages p
        LEFT JOIN page_purge_requests r ON r.page_id=p.id WHERE p.workspace_id=$1 AND p.id=$2 FOR UPDATE OF p`,
        [scope.workspace_id, id],
      );
      if (!page || (page.deleted && page.requested_by !== scope.user_id))
        throw new HTTPException(404, { message: 'Page not found' });
      if (page.deleted) return page.completed_at !== null;
      const level = pageStandings(await loadIndexPages(db, scope.workspace_id, scope.user_id), scope.role)[id]
        ?.level;
      if (!level) throw new HTTPException(404, { message: 'Page not found' });
      if (level !== 'full') throw new HTTPException(403, { message: 'Full page access required' });
      if (!page.trashed) throw new HTTPException(409, { message: 'Mettez d’abord la page à la corbeille.' });
      if (
        (
          await db.query(
            "SELECT 1 FROM pages WHERE workspace_id=$1 AND metadata->>'parentId'=$2 AND NOT deleted LIMIT 1",
            [scope.workspace_id, id],
          )
        ).rowCount
      ) {
        throw new HTTPException(409, { message: 'Purgez ou déplacez d’abord les sous-pages.' });
      }
      await db.query('UPDATE pages SET deleted=true WHERE workspace_id=$1 AND id=$2', [
        scope.workspace_id,
        id,
      ]);
      await db.query('UPDATE workspaces SET revision=revision+1 WHERE id=$1', [scope.workspace_id]);
      await db.query('INSERT INTO page_purge_requests(page_id,requested_by) VALUES($1,$2)', [
        id,
        scope.user_id,
      ]);
      return false;
    });
    if (completed || (await finishPagePurge(pool, id, purgeRoom))) return c.json({ purged: id });
    return c.json({ pending: id }, 202);
  });
  return app;
}

export function startPurgeRetries(pool: PgPool, purgeRoom: Purger) {
  let running: Promise<void> | undefined;
  const retry = async () => {
    const { rows } = await pool.query<{ page_id: string }>(`SELECT page_id FROM page_purge_requests
      WHERE completed_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 8`);
    await Promise.all(rows.map((row) => finishPagePurge(pool, row.page_id, purgeRoom)));
  };
  const tick = () => {
    running ??= retry()
      .catch((error) => console.error('[page-purge]', error.name))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
