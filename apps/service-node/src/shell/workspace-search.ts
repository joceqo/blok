import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgPool } from '../db/pool.ts';
import { sessionDigest } from './session.ts';
import { pageBlockText } from './page-search-text.ts';
import { loadIndexPages, pageStandings } from './workspace-index.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';

interface Source { id: string; title: string; excerpt: string; blockId?: string }

export function createWorkspaceSearch(pool: PgPool) {
  const router = new Hono();
  router.post('/', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'Question trop longue' }, 413) }), async c => {
    const key = sessionDigest(c);
    if (!key) return c.json({ error: 'Sign in required' }, 401);
    const body = await c.req.json().catch(() => null);
    const question = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!question || question.length > 1200) return c.json({ error: 'La recherche accepte entre 1 et 1 200 caractères.' }, 400);
    const palette = body?.mode === 'palette';
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const { workspace_id, user_id, role } = await readWorkspaceScope(client, key, c.req.param('slug')!, false);
      const rows = await loadIndexPages(client, workspace_id, user_id);
      const standing = pageStandings(rows, role);
      const ids = rows.filter(row => !row.trashed && standing[row.id]).map(row => row.id);
      // One row per block, so the best-ranked block of a page becomes the citation. The LEFT JOIN
      // keeps a page whose title alone matches, and a block with no id simply cites nothing.
      const result = await client.query<Source & { blockId: string | null }>(`
        WITH terms AS (
          SELECT to_tsquery('french', string_agg(quote_literal(term) || CASE WHEN $4 THEN ':*' ELSE '' END,' | ')) AS q
          FROM unnest(tsvector_to_array(to_tsvector('french',translate($3,'’‘ʼ','   ')))) AS term
        ), documents AS (
          SELECT p.id, coalesce(p.metadata->>'title','') AS title, parts.block_id, parts.body
          FROM pages p LEFT JOIN LATERAL ${pageBlockText} parts ON true
          WHERE p.workspace_id=$1 AND p.id=ANY($2::text[]) AND NOT p.trashed AND NOT p.deleted
        ), indexed AS (
          SELECT *,setweight(to_tsvector('french',translate(title,'’‘ʼ','   ')),'A') || to_tsvector('french',translate(coalesce(body,''),'’‘ʼ','   ')) AS words FROM documents
        ), hits AS (
          SELECT DISTINCT ON (id) id,title,block_id,body,q,ts_rank(words,q) AS rank
            FROM indexed,terms WHERE words @@ q
            ORDER BY id,ts_rank(words,q) DESC,block_id NULLS LAST
        )
        SELECT id,title,block_id AS "blockId",
          left(ts_headline('french',coalesce(body,title),q,'MaxWords=45,MinWords=12,StartSel="",StopSel=""'),800) AS excerpt
          FROM hits ORDER BY rank DESC,id LIMIT $5`, [workspace_id, ids, question, palette, palette ? 40 : 5]);
      await client.query('COMMIT');
      // A page cited without a block leaves the key out rather than sending null.
      return c.json({ sources: result.rows.map(({ blockId, ...source }) => (blockId === null ? source : { ...source, blockId })) });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof WorkspaceError) return c.json({ error: error.message }, error.status);
      throw error;
    } finally {
      client.release();
    }
  });
  return router;
}
