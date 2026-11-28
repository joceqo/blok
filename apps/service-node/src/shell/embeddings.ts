import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';
import { openAiKey } from './ai-crypto.ts';
import { inTransaction } from './bootstrap.ts';
import { AiError, provider } from './hosted-ai.ts';
import { chunkBlocks, type BlockText } from './page-chunks.ts';
import { pageBlockText } from './page-search-text.ts';
import { readWorkspaceScope } from './workspace-scope.ts';

import { recordAiUsage } from './ai-usage.ts';

const MODEL = 'text-embedding-3-small';
const PROFILE = MODEL + ':1536:v1';
const BATCH_SIZE = 32;
// Calibrated for this model on French workspace questions. Rank alone always returns a neighbour.
const MIN_COSINE_SIMILARITY = 0.4;
const enabledKey = "k.scope='workspace' AND k.embeddings_enabled AND k.encrypted_key IS NOT NULL";
interface Key {
  user_id?: string;
  workspace_id: string;
  encrypted_key: Buffer;
}
type Stage = 'query' | 'index';
type Embed = (key: Key, inputs: string[], signal: AbortSignal, stage: Stage) => Promise<number[][]>;

export function createEmbeddings(master: Buffer, fetcher: typeof fetch = fetch, usagePool?: PgPool): Embed {
  return async (key, inputs, signal, stage) => {
    const started = Date.now();
    try {
      const secret = openAiKey(master, 'workspace:' + key.workspace_id, key.encrypted_key);
      const result = await provider(
        fetcher,
        secret,
        'embeddings',
        { model: MODEL, dimensions: 1536, input: inputs, encoding_format: 'float' },
        signal,
      );
      if (!Array.isArray(result.data) || result.data.length !== inputs.length)
        throw new Error('Incomplete embeddings');
      const vectors: number[][] = [];
      for (const item of result.data) {
        if (
          !Number.isInteger(item?.index) ||
          item.index < 0 ||
          item.index >= inputs.length ||
          vectors[item.index] ||
          !Array.isArray(item.embedding) ||
          item.embedding.length !== 1536 ||
          !item.embedding.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) ||
          !item.embedding.some((n: number) => n !== 0)
        )
          throw new Error('Invalid embedding');
        vectors[item.index] = item.embedding;
      }
      const tokens =
        result.usage && typeof result.usage === 'object' && 'total_tokens' in result.usage
          ? result.usage.total_tokens
          : undefined;
      console.info(
        JSON.stringify({
          event: 'embedding.' + stage,
          model: MODEL,
          outcome: 'ok',
          inputs: inputs.length,
          ms: Date.now() - started,
          ...(Number.isSafeInteger(tokens) && { tokens }),
        }),
      );
      if (usagePool) await recordAiUsage(usagePool, key.workspace_id, key.user_id ?? '', stage, result.usage, MODEL);
      return vectors;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'embedding.' + stage,
          model: MODEL,
          outcome: 'failed',
          ms: Date.now() - started,
          ...(error instanceof AiError && { status: error.status }),
        }),
      );
      throw error;
    }
  };
}

export async function indexNextPage(pool: PgPool, embed: Embed, signal: AbortSignal) {
  const lease = randomUUID();
  const claimed = await pool.query<Key & { page_id: string }>(
    `
    WITH candidate AS (
      SELECT j.page_id,p.workspace_id,k.encrypted_key FROM page_embedding_jobs j
      JOIN pages p ON p.id=j.page_id JOIN ai_credentials k ON k.owner_id=p.workspace_id AND ${enabledKey}
      WHERE j.due_at<=now() AND NOT p.trashed AND NOT p.deleted
      ORDER BY j.due_at,j.page_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
    ) UPDATE page_embedding_jobs j SET lease=$1,due_at=now()+interval '2 minutes'
      FROM candidate c WHERE j.page_id=c.page_id RETURNING c.*`,
    [lease],
  );
  const job = claimed.rows[0];
  if (!job) return false;
  try {
    // One snapshot for the page and the trail of pages above it.
    const { rows, above } = await inTransaction(pool, async (db) => {
      const blocks = await db.query<BlockText & { title: string; label: string | null; parentId: string | null }>(
      `
      SELECT parts.block_id AS "blockId",coalesce(parts.body,'') AS body,coalesce(p.metadata->>'title','') AS title,
        parts.block_type AS type,parts.label,parts.parent_id AS "parentId"
      FROM pages p LEFT JOIN LATERAL ${pageBlockText} parts ON true
      WHERE p.id=$1 AND NOT p.trashed AND NOT p.deleted ORDER BY parts.ord`,
      [job.page_id],
    );
    // The trail of pages above this one. A passage says far more when it knows it sits under
    // "Ressources humaines" than when it only knows its own page.
    const trail = await db.query<{ title: string }>(
      `WITH RECURSIVE trail(id,parent,title,depth) AS (
        SELECT p.id,p.metadata->>'parentId',coalesce(p.metadata->>'title',''),0 FROM pages p WHERE p.id=$1
        UNION ALL
        SELECT p.id,p.metadata->>'parentId',coalesce(p.metadata->>'title',''),trail.depth+1
          FROM pages p JOIN trail ON p.id=trail.parent AND trail.depth<8 WHERE NOT p.deleted
      ) SELECT title FROM trail ORDER BY depth DESC`,
      [job.page_id],
      );

      return { rows: blocks.rows, above: trail.rows };
    });
    // A row names the database that holds it, as AFFiNE's `additional.databaseName` does.
    const named = new Map(
      rows.flatMap((row) => (row.label === null || row.blockId === null ? [] : [[row.blockId, row.label] as const])),
    );
    const chunks = chunkBlocks(
      rows.map((row) => ({ ...row, parentName: named.get(row.parentId ?? '') ?? null })),
      above.map((row) => row.title.trim().slice(0, 200)),
    );
    const title = rows[0]?.title.trim().slice(0, 500) ?? '';
    if (!chunks.length && title) chunks.push({ index: 0, text: title, blockIds: [], context: '' });
    const vectors: number[][] = [];
    for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
      signal.throwIfAborted();
      // A new projection, purge, credential removal or expired lease supersedes the job.
      const valid = await pool.query(
        `UPDATE page_embedding_jobs j SET due_at=now()+interval '2 minutes'
        WHERE j.page_id=$1 AND j.lease=$2 AND EXISTS (SELECT FROM ai_credentials k
          WHERE k.owner_id=$3 AND ${enabledKey} AND k.encrypted_key=$4)`,
        [job.page_id, lease, job.workspace_id, job.encrypted_key],
      );
      if (!valid.rowCount) return true;
      // The context is embedded with the chunk and stored apart from it: the vector knows where
      // the passage comes from, the reader is still shown the words that were written.
      const inputs = chunks
        .slice(start, start + BATCH_SIZE)
        .map((chunk) => (chunk.context && chunk.context !== chunk.text ? chunk.context + '\n' + chunk.text : chunk.text));
      vectors.push(...(await embed(job, inputs, signal, 'index')));
    }
    await inTransaction(pool, async (db) => {
      // Lock in the same order as the page trigger. Never publish a stale worker's result.
      const page = await db.query(
        'SELECT version FROM pages WHERE id=$1 AND NOT trashed AND NOT deleted FOR SHARE',
        [job.page_id],
      );
      if (!page.rowCount) return;
      const done = await db.query(
        `UPDATE page_embedding_jobs SET due_at=NULL,lease=NULL,attempts=0
        WHERE page_id=$1 AND lease=$2 AND EXISTS(SELECT FROM ai_credentials k WHERE k.owner_id=$3 AND ${enabledKey} AND k.encrypted_key=$4)`,
        [job.page_id, lease, job.workspace_id, job.encrypted_key],
      );
      if (!done.rowCount) return;
      await db.query('DELETE FROM page_chunks WHERE page_id=$1 AND model=$2', [job.page_id, PROFILE]);
      for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
        const records = chunks.slice(start, start + BATCH_SIZE).map((chunk) => ({
          id: randomUUID(),
          idx: chunk.index,
          body: chunk.text,
          blocks: chunk.blockIds,
          vec: JSON.stringify(vectors[chunk.index]),
        }));
        await db.query(
          `INSERT INTO page_chunks(id,page_id,workspace_id,chunk_index,text,block_ids,embedding,model,page_version)
          SELECT id,$1,$2,idx,body,blocks,vec::vector,$3,$4 FROM
          jsonb_to_recordset($5) AS x(id text,idx int,body text,blocks text[],vec text)`,
          [job.page_id, job.workspace_id, PROFILE, page.rows[0].version, JSON.stringify(records)],
        );
      }
    });
  } catch (error) {
    await pool.query(
      `UPDATE page_embedding_jobs SET lease=NULL, attempts=attempts+1,
      due_at=now()+ interval '30 seconds' * power(2,least(attempts,7)) WHERE page_id=$1 AND lease=$2`,
      [job.page_id, lease],
    );
    throw error;
  }
  return true;
}

export function startEmbeddingWorker(pool: PgPool, embed: Embed) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let pending: Promise<void> = Promise.resolve();
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      pending = indexNextPage(pool, embed, controller.signal)
        .then((found) => {
          if (!controller.signal.aborted) schedule(found ? 100 : 3000);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            console.warn(JSON.stringify({ event: 'embedding.retry', reason: 'index_failed' }));
            schedule(3000);
          }
        });
    }, delay);
    timer.unref();
  };
  schedule(0);
  return async () => {
    controller.abort();
    clearTimeout(timer);
    await pending;
  };
}

export async function embedQuestion(
  pool: PgPool,
  embed: Embed,
  session: string,
  slug: string,
  question: string,
  signal: AbortSignal,
) {
  const key = await inTransaction(pool, async (db) => {
    const scope = await readWorkspaceScope(db, session, slug, false);
    const result = await db.query<Key>(
      `SELECT k.owner_id AS workspace_id,k.encrypted_key FROM ai_credentials k
      WHERE k.owner_id=$1 AND ${enabledKey} AND EXISTS(SELECT FROM page_chunks c WHERE c.workspace_id=$1 AND c.model=$2)`,
      [scope.workspace_id, PROFILE],
    );
    if (!result.rows[0]) return;
    const rate = await db.query(
      `INSERT INTO email_rate_limits(key,count) VALUES($1,1)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN email_rate_limits.window_start<now()-interval '1 minute' THEN 1 ELSE email_rate_limits.count+1 END,
        window_start=CASE WHEN email_rate_limits.window_start<now()-interval '1 minute' THEN now() ELSE email_rate_limits.window_start END RETURNING count`,
      ['embedding:' + scope.user_id],
    );
    if (rate.rows[0].count <= 30) return {...result.rows[0],user_id:scope.user_id};
  });
  if (!key) return;
  const [vector] = await embed(
    key,
    [question],
    AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    'query',
  );
  return { workspace: key.workspace_id, vector: JSON.stringify(vector) };
}

export interface SearchHit {
  id: string;
  title: string;
  excerpt: string;
  blockId: string | null;
}
export async function semanticHits(
  db: PoolClient,
  workspace: string,
  ids: string[],
  vector: string,
  limit: number,
) {
  // Exact cosine search ranks only the readable corpus in the caller's ACL snapshot.
  return (
    await db.query<SearchHit>(
      `WITH hits AS (
    SELECT DISTINCT ON (p.id) p.id,coalesce(p.metadata->>'title','') AS title,left(c.text,800) AS excerpt,
      c.block_ids[1] AS "blockId", c.embedding <=> $3::vector AS distance
      FROM pages p JOIN page_chunks c ON c.page_id=p.id AND c.workspace_id=p.workspace_id
      JOIN page_embedding_jobs j ON j.page_id=p.id AND j.due_at IS NULL
      JOIN ai_credentials k ON k.owner_id=p.workspace_id AND ${enabledKey}
      WHERE p.workspace_id=$1 AND p.id=ANY($2::text[]) AND NOT p.deleted AND NOT p.trashed
        AND c.model=$4 AND c.embedding IS NOT NULL AND c.page_version=p.version
      ORDER BY p.id,distance,c.chunk_index
    ) SELECT id,title,excerpt,"blockId" FROM hits WHERE distance <= $6 ORDER BY distance,id LIMIT $5`,
      [workspace, ids, vector, PROFILE, limit, 1 - MIN_COSINE_SIMILARITY],
    )
  ).rows;
}

/** Reciprocal rank fusion. Prefer a literal matching block as the citation on a shared hit. */
export function mergeHits(words: SearchHit[], semantic: SearchHit[], limit: number) {
  const hits = new Map<string, { source: SearchHit; score: number }>();
  for (const list of [words, semantic])
    list.forEach((source, index) => {
      const hit = hits.get(source.id) ?? { source, score: 0 };
      hit.score += 1 / (61 + index);
      hits.set(source.id, hit);
    });
  return [...hits.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.source);
}
