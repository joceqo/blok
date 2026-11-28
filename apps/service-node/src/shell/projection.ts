import {recordCommentNotifications, type RecordedNotice} from './comment-notifications.ts';
import {deliverNotificationMails} from './notification-mail.ts';
import type { PgPool } from '../db/pool.ts';

export interface ProjectionHead {
  version: string;
  lineage: string | null;
  sequence: string | null;
}

interface ProjectionWrite extends ProjectionHead {
  reset?: true;
  expected?: Pick<ProjectionHead, 'lineage' | 'sequence'>;
}

function validSequence(value: string) {
  return /^[0-9]{1,20}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}

export function readProjectionHeaders(headers: Headers): ProjectionWrite | undefined {
  const version = headers.get('Blok-Doc-Version');
  const lineage = headers.get('Blok-Doc-Lineage');
  const sequence = headers.get('Blok-Doc-Sequence');
  if ((lineage === null) !== (sequence === null) || lineage === '') return undefined;
  if (version !== null && !/^(0|[1-9][0-9]{0,18})$/.test(version)) return undefined;
  if (sequence !== null && !validSequence(sequence)) {
    return undefined;
  }
  const reset = headers.get('Blok-Doc-Reset');
  const mode = headers.get('Blok-Doc-If-Match');
  const expectedLineage = headers.get('Blok-Doc-Expected-Lineage');
  const expectedSequence = headers.get('Blok-Doc-Expected-Sequence');
  if (reset !== null && (reset !== '1' || mode !== 'exact' || !lineage || !/^[a-f0-9]{32}$/.test(lineage) || lineage === expectedLineage || sequence !== '0')) return undefined;
  if (mode !== null || expectedLineage !== null || expectedSequence !== null) {
    if (mode !== 'exact' || version === null || lineage === null || sequence === null ||
        expectedLineage === null || expectedSequence === null ||
        (expectedLineage === '') !== (expectedSequence === '') ||
        (expectedSequence !== '' && !validSequence(expectedSequence))) return undefined;
    return { ...(reset && {reset:true as const}), version, lineage, sequence: BigInt(sequence).toString(),
      expected: { lineage: expectedLineage || null, sequence: expectedSequence ? BigInt(expectedSequence).toString() : null } };
  }
  // A journal can recover before its best-effort endpoint version read has finished.
  return { version: version ?? '', lineage, sequence: sequence === null ? null : BigInt(sequence).toString() };
}

export function projectionDecision(stored: ProjectionHead, incoming: ProjectionWrite, sameData: boolean) {
  const expected = incoming.expected;
  if (incoming.reset) {
    return expected && sameData && incoming.version === stored.version && stored.lineage === expected.lineage &&
      stored.sequence === expected.sequence && incoming.lineage !== stored.lineage && incoming.sequence === '0' ? 'write' : 'conflict';
  }
  if (expected && (stored.version !== incoming.version || stored.lineage !== expected.lineage ||
      stored.sequence !== expected.sequence || (stored.lineage !== null && stored.lineage !== incoming.lineage))) {
    return 'conflict';
  }
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
export async function saveProjection(pool: PgPool, id: string, json: string, head: ProjectionWrite, nodeRoomWorkspace?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hasComments = !head.reset && json.includes('database-comment');
    const { rows } = await client.query<ProjectionHead & { same: boolean; workspaceId: string; previous: unknown }>(
      `SELECT version::text, lineage, sequence::text, workspace_id AS "workspaceId", CASE WHEN $4 THEN content END AS previous, (content IS NOT DISTINCT FROM $2::jsonb OR ($3 AND content IS NULL AND $2::jsonb='null'::jsonb)) AS same
       FROM pages WHERE id=$1 AND NOT deleted FOR UPDATE`, [id, json, head.reset ?? false, hasComments],
    );
    const row = rows[0];
    // The owning workspace is read under the same row lock as the CAS.
    // Node uses exact heads; the Go writer uses the legacy callback.
    const wrongWriter = nodeRoomWorkspace && row &&
      (row.workspaceId === nodeRoomWorkspace) !== Boolean(head.expected);
    const decision = row && !wrongWriter ? projectionDecision(row, head, row.same) : 'conflict';
    if (!row || decision === 'conflict') {
      await client.query('ROLLBACK');
      return undefined;
    }
    let version = row.version;
    let notices: RecordedNotice[] = [];
    if (decision === 'write') {
      const updated = await client.query<{ version: string }>(
        `UPDATE pages SET content=CASE WHEN $5 THEN content ELSE $2::jsonb END, version=version+1, lineage=$3, sequence=$4
         WHERE id=$1 RETURNING version::text`, [id, json, head.lineage, head.sequence, head.reset ?? false],
      );
      version = updated.rows[0]!.version;
      if (hasComments && !row.same) notices = await recordCommentNotifications(client,row.workspaceId,id,row.previous,JSON.parse(json));
    }
    await client.query('COMMIT');
    // After the commit only: a mail must never announce a write that rolled back.
    if (notices.length) await deliverNotificationMails(pool, row.workspaceId, notices);
    return version;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
