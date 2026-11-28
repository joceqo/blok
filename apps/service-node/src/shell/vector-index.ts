import type { PgPool } from '../db/pool.ts';

/**
 * L'index vectoriel des pages : une ligne par morceau de document.
 *
 * Il vit à côté du schéma canonique, pas dedans, parce qu'il dépend d'une extension que toutes les
 * installations n'ont pas. Une instance sans pgvector démarre normalement et garde la recherche
 * lexicale ; elle perd seulement la recherche par le sens.
 *
 * `page_version` porte la fraîcheur : `pages.version` existe déjà, donc on sait qu'un morceau est
 * périmé sans rien recalculer. `model` porte la génération d'embedding : changer de modèle ne
 * mélange pas des vecteurs incomparables, il suffit d'indexer sous un nouveau nom puis de basculer.
 */
const TABLE = `CREATE TABLE IF NOT EXISTS page_chunks(
  id text PRIMARY KEY,
  page_id text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  chunk_index int NOT NULL,
  text text NOT NULL,
  block_ids text[] NOT NULL DEFAULT '{}',
  embedding vector(1536),
  model text NOT NULL,
  page_version bigint NOT NULL,
  -- Fingerprint of the exact text sent to the model, so an unchanged passage is never paid twice.
  digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(page_id, model, chunk_index)
)`;

// Une page se réindexe d'un bloc : on supprime puis on réinsère ses morceaux.
const BY_PAGE = 'CREATE INDEX IF NOT EXISTS page_chunks_page ON page_chunks(page_id, model)';
// La recherche filtre d'abord sur l'espace, puis classe par distance.
const BY_WORKSPACE = 'CREATE INDEX IF NOT EXISTS page_chunks_workspace ON page_chunks(workspace_id, model)';

/**
 * Prépare l'index vectoriel si l'extension est disponible.
 * @param projection La recette en cours — modèle, dimension et version de la projection. Une page
 *   lue sous une autre est en retard : elle ne répond plus du tout, puisqu'une recherche ne
 *   retient que le profil courant. La file s'en souvient pour les rattraper une à une.
 * @returns `true` quand la recherche par le sens peut servir, `false` quand l'instance s'en passe.
 */
export async function ensureVectorIndex(pool: Pick<PgPool, 'query'>, projection: string): Promise<boolean> {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch {
    // Pas de pgvector : l'instance reste en recherche lexicale, sans incident.
    return false;
  }
  await pool.query(TABLE);
  // Existing installations get the fingerprint column; their rows simply refill on next read.
  await pool.query('ALTER TABLE page_chunks ADD COLUMN IF NOT EXISTS digest text');
  await pool.query(BY_PAGE);
  await pool.query(BY_WORKSPACE);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_embedding_jobs (
      page_id text PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      due_at timestamptz DEFAULT now(), lease uuid, attempts integer NOT NULL DEFAULT 0
    );
    ALTER TABLE page_embedding_jobs ADD COLUMN IF NOT EXISTS model text;
    CREATE INDEX IF NOT EXISTS page_embedding_due ON page_embedding_jobs(due_at) WHERE due_at IS NOT NULL;
    CREATE OR REPLACE FUNCTION queue_page_embedding() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.deleted OR NEW.trashed THEN
        DELETE FROM page_chunks WHERE page_id=NEW.id;
        DELETE FROM page_embedding_jobs WHERE page_id=NEW.id;
        RETURN NULL;
      END IF;
      INSERT INTO page_embedding_jobs(page_id) VALUES(NEW.id) ON CONFLICT(page_id)
        DO UPDATE SET due_at=now(), lease=NULL, attempts=0;
      -- Every passage below this page carries this page's name in the trail it was embedded with.
      -- Rename or move it and that trail is wrong everywhere underneath, while none of those rows
      -- changed. Re-queue the whole subtree: renaming is rare, and a stale name is worse than a
      -- few embeddings. The depth bound is the one pageStandings walks, and it also ends a cycle.
      IF TG_OP='UPDATE' AND (OLD.metadata->>'title' IS DISTINCT FROM NEW.metadata->>'title'
        OR OLD.metadata->>'parentId' IS DISTINCT FROM NEW.metadata->>'parentId') THEN
        INSERT INTO page_embedding_jobs(page_id)
        SELECT id FROM (
          WITH RECURSIVE below(id,depth) AS (
            SELECT p.id,0 FROM pages p
              WHERE p.metadata->>'parentId'=NEW.id AND NOT p.deleted AND NOT p.trashed
            UNION ALL
            SELECT p.id,below.depth+1 FROM pages p JOIN below ON p.metadata->>'parentId'=below.id
              WHERE NOT p.deleted AND NOT p.trashed AND below.depth<64
          ) SELECT DISTINCT id FROM below
        ) subtree
        ON CONFLICT(page_id) DO UPDATE SET due_at=now(), lease=NULL, attempts=0;
      END IF;
      RETURN NULL;
    END $$;
    CREATE OR REPLACE TRIGGER queue_embedding_insert AFTER INSERT ON pages
      FOR EACH ROW EXECUTE FUNCTION queue_page_embedding();
    CREATE OR REPLACE TRIGGER queue_embedding_update AFTER UPDATE OF content,metadata,version,trashed,deleted ON pages
      FOR EACH ROW WHEN (OLD.version IS DISTINCT FROM NEW.version OR OLD.content IS DISTINCT FROM NEW.content
        OR OLD.metadata->>'title' IS DISTINCT FROM NEW.metadata->>'title'
        OR OLD.metadata->>'parentId' IS DISTINCT FROM NEW.metadata->>'parentId'
        OR OLD.trashed IS DISTINCT FROM NEW.trashed OR OLD.deleted IS DISTINCT FROM NEW.deleted)
      EXECUTE FUNCTION queue_page_embedding();
    INSERT INTO page_embedding_jobs(page_id) SELECT id FROM pages WHERE NOT deleted AND NOT trashed
      ON CONFLICT DO NOTHING
  `);
  // Pages read under an older recipe. Marked due, not rebuilt here: the worker takes them one at
  // a time, so a recipe change costs a slow catch-up rather than a stall.
  await pool.query(
    `UPDATE page_embedding_jobs SET due_at=now(), lease=NULL, attempts=0
     WHERE due_at IS NULL AND model IS DISTINCT FROM $1`,
    [projection],
  );
  return true;
}
