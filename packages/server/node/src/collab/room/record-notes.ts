import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { syncDirectory } from './page-seed.ts';

export type RecordNote = { kind: 'person' } | { kind: 'agent'; onBehalfOf?: string };
export type HistoryActor = RecordNote & { id: string };
type Stored = RecordNote & { operationId: string };

export function notesFilename(lineage: string) {
  if (!/^[a-f0-9]{32}$/.test(lineage)) throw new Error('Invalid record-note lineage');
  return 'record-notes.' + lineage;
}

// Each append happens under the same document lease and queue as its durable record.
// Match the operation as well as the sequence when the journal has been restored.
export async function writeRecordNote(
  directory: string,
  lineage: string,
  sequence: bigint,
  operationId: string,
  note: RecordNote,
) {
  const path = join(directory, notesFilename(lineage));
  let created = false;
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let file: FileHandle;
  try {
    file = await open(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    file = await open(path, flags);
  }
  try {
    // The leading newline isolates a torn previous append.
    await file.writeFile('\n' + JSON.stringify({ sequence: String(sequence), operationId, ...note }) + '\n');
    await file.sync();
    if (created) await syncDirectory(directory);
  } finally {
    await file.close();
  }
}

export async function readRecordNotes(directory: string, lineage: string) {
  const notes = new Map<bigint, Stored>();
  let input: FileHandle | undefined;
  try {
    input = await open(
      join(directory, notesFilename(lineage)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!(await input.stat()).isFile()) throw new Error('Invalid record notes file');
    for await (const line of input.readLines({ autoClose: false })) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !row ||
        typeof row.sequence !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(row.sequence) ||
        typeof row.operationId !== 'string' ||
        !/^[a-f0-9]{32}$/.test(row.operationId) ||
        (row.kind !== 'agent' && row.kind !== 'person') ||
        (row.onBehalfOf !== undefined && typeof row.onBehalfOf !== 'string')
      )
        continue;
      notes.set(BigInt(row.sequence), row);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('Could not read collaboration record notes');
  } finally {
    await input?.close();
  }
  return notes;
}

export function recordActor(
  notes: ReadonlyMap<bigint, Stored>,
  record: { sequence: bigint; operationId: string },
  actor: string | null,
): HistoryActor | undefined {
  const stored = notes.get(record.sequence);
  if (!actor || !stored || stored.operationId !== record.operationId) return;
  return stored.kind === 'agent' && stored.onBehalfOf
    ? { id: actor, kind: 'agent', onBehalfOf: stored.onBehalfOf }
    : { id: actor, kind: stored.kind };
}
