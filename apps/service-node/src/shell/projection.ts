import type { PgPool } from '../db/pool.ts';

export interface ProjectionHead {
  version: string;
  lineage: string | null;
  sequence: string | null;
}

export function readProjectionHeaders(headers: Headers): ProjectionHead | undefined {
  const version = headers.get('Blok-Doc-Version');
  const lineage = headers.get('Blok-Doc-Lineage');
  const sequence = headers.get('Blok-Doc-Sequence');
  if ((lineage === null) !== (sequence === null) || lineage === '') return undefined;
  if (version !== null && !/^(0|[1-9][0-9]{0,18})$/.test(version)) return undefined;
  if (sequence !== null && (!/^[0-9]{1,20}$/.test(sequence) || BigInt(sequence) > 0xffffffffffffffffn)) {
    return undefined;
  }
  // A journal can recover before its best-effort endpoint version read has finished.
  return { version: version ?? '', lineage, sequence: sequence === null ? null : BigInt(sequence).toString() };
}

export function projectionDecision(stored: ProjectionHead, incoming: ProjectionHead, sameData: boolean) {
  const sameLineage = incoming.lineage !== null && incoming.lineage === stored.lineage;
  if (sameLineage && stored.sequence !== null && incoming.sequence !== null) {
    const next = BigInt(incoming.sequence);
    const current = BigInt(stored.sequence);
    if (next < current) return 'conflict';
    if (next === current) return sameData ? 'retry' : 'conflict';
  }
  // A client may retry a non-journal export after losing its acknowledgment.
  if (stored.lineage === null && incoming.lineage === null && sameData) return 'retry';

  if (incoming.version === stored.version) return 'write';
  if (incoming.version === '' && (stored.version === '0' || sameLineage)) return 'write';
  return 'conflict';
}

/** The lock makes the revision comparison and its update atomic across workers. */
export async function saveProjection(pool: PgPool, id: string, json: string, head: ProjectionHead) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<ProjectionHead & { same: boolean }>(
      `SELECT version::text, lineage, sequence::text, content IS NOT DISTINCT FROM $2::jsonb AS same
       FROM pages WHERE id=$1 FOR UPDATE`, [id, json],
    );
    const row = rows[0];
    const decision = row && projectionDecision(row, head, row.same);
    if (!row || decision === 'conflict') {
      await client.query('ROLLBACK');
      return undefined;
    }
    let version = row.version;
    if (decision === 'write') {
      const updated = await client.query<{ version: string }>(
        `UPDATE pages SET content=$2::jsonb, version=version+1, lineage=$3, sequence=$4
         WHERE id=$1 RETURNING version::text`, [id, json, head.lineage, head.sequence],
      );
      version = updated.rows[0]!.version;
    }
    await client.query('COMMIT');
    return version;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
