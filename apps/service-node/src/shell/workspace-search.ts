import {readWorkspaceDatabases} from './workspace-databases.ts';
import {DatabaseInputError} from './database-reader.ts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgPool } from '../db/pool.ts';
import { requestIdOf } from '../middleware/observe.ts';
import { sessionDigest } from './session.ts';
import { pageBlockText } from './page-search-text.ts';
import { loadIndexPages, pageStandings } from './workspace-index.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';

import { embedQuestion, mergeHits, semanticHits, type SearchHit, type createEmbeddings } from './embeddings.ts';

export function createWorkspaceSearch(pool: PgPool, embed?: ReturnType<typeof createEmbeddings>) {
  const router = new Hono();
  router.post('/databases', bodyLimit({maxSize:16384}), async c => {
    const token=sessionDigest(c);
    if (!token) return c.json({error:'Sign in required'},401);
    const input=await c.req.json().catch(()=>null);
    if (input?.action!=='list' && input?.action!=='query') return c.json({error:'Action inconnue'},400);
    const db=await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scope=await readWorkspaceScope(db,token,c.req.param('slug')!,false);
      const result=await readWorkspaceDatabases(db,scope.workspace_id,scope.user_id,scope.role,input.action,input);
      await db.query('COMMIT');
      return c.json(result);
    } catch (e) {
      await db.query('ROLLBACK');
      if (e instanceof WorkspaceError) return c.json({error:e.message},e.status);
      if (e instanceof DatabaseInputError) return c.json({error:e.message},400);
      throw e;
    } finally {db.release();}
  });
  router.post('/', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'Question trop longue' }, 413) }), async c => {
    const key = sessionDigest(c);
    if (!key) return c.json({ error: 'Sign in required' }, 401);
    const body = await c.req.json().catch(() => null);
    const question = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!question || question.length > 1200) return c.json({ error: 'La recherche accepte entre 1 et 1 200 caractères.' }, 400);
    const palette = body?.mode === 'palette';
    // Started, not awaited: turning the question into a vector is a round trip to the provider,
    // and the lexical pass needs none of it. Run side by side, a question costs the slower of the
    // two instead of their sum. The vector is only needed once the readable pages are known.
    const asking = !palette && embed ? embedQuestion(pool,embed,key,c.req.param('slug')!,question,c.req.raw.signal)
      .catch(error => {
        if (c.req.raw.signal.aborted) throw error;
        // A missing or unavailable provider leaves the lexical path available.
        return undefined;
      }) : undefined;
    // An abort is re-thrown above, and the real await is further down. Should the request fail
    // before then — a refused scope, a closed connection — that rejection would be unobserved.
    asking?.catch(() => undefined);
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
      const result = await client.query<SearchHit>(`
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
      let sources = result.rows;
      const queryVector = await asking;
      if (queryVector?.workspace === workspace_id) {
        await client.query('SAVEPOINT semantic');
        try {
          const hits = await semanticHits(client,workspace_id,ids,queryVector.vector,5);
          sources = mergeHits(sources,hits,5);
          console.info(JSON.stringify({event:'search.hybrid', request:requestIdOf(c),lexical:result.rowCount,semantic:hits.length,returned:sources.length}));
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT semantic');
          console.warn(JSON.stringify({event:'search.fallback',request:requestIdOf(c),reason:'vector_query_failed'}));
        }
      }
      await client.query('COMMIT');
      // A page cited without a block leaves the key out rather than sending null.
      return c.json({ sources: sources.map(({ blockId, ...source }) => (blockId === null ? source : { ...source, blockId })) });
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
