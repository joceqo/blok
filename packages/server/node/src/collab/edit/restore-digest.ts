/**
 * The digest a restore is journalled under, and the one an idempotency key is
 * matched against. It is taken over the request line — the lineage, the point
 * and whether the databases are kept — never over the plan the restore makes,
 * so a retry of the same request digests the same however the document moved.
 *
 * A sequence is a ulong: `18446744073709551615` is a real one, and no Number
 * can hold it. It stays a bigint all the way to the text.
 */

import { createHash } from 'node:crypto';

/** With `keepDatabases` the line ends in `\nkeep`, so one key across the two kinds of restore is two edits. */
export function restoreDigest(lineage: string, sequence: bigint, keepDatabases: boolean): Buffer {
  const line = 'restore\n' + lineage + '\n' + sequence + (keepDatabases ? '\nkeep' : '');
  return createHash('sha256').update(line, 'utf8').digest();
}
