import { open, readdir, type FileHandle } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  BASELINE_MAGIC, CHECKPOINT_MAGIC, MANIFEST_FILE_NAME, InvalidDataError,
  baselineName, checkpointName, journalName, readManifest, readSealed, type JournalManifest,
} from './files.ts';
import { decodeRecord, RECORD_HEADER_BYTES, type OperationRecord } from './record.ts';

export interface JournalFrame {
  source: 'baseline' | 'checkpoint' | 'journal';
  sequence: bigint;
  update: Uint8Array;
}
interface SequenceReport {
  file: string;
  verifiedBytes: bigint;
  firstSequence: bigint | null;
  durableThrough: bigint;
  tailRecords: bigint;
}
export interface JournalInspection {
  directory: string;
  state: 'unknown' | 'seeded' | 'unseeded' | 'purged';
  integrity: 'ok' | 'incomplete' | 'corrupt' | 'missing' | 'unreadable';
  manifest: JournalManifest | null;
  baseline: {file: string; frames: number} | null;
  checkpoint: {file: string; through: bigint} | null;
  journal: SequenceReport | null;
  issue?: string;
}

class IncompleteRecord extends Error {}
class ConsumerError extends Error {}

async function fill(file: FileHandle, target: Buffer): Promise<number> {
  let offset = 0;
  while (offset < target.length) {
    const { bytesRead } = await file.read(target, offset, target.length - offset, null);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset;
}

/** Verify the two checksums, contiguous sequence and unique operation ID per record. */
async function scan(file: FileHandle, summary: SequenceReport, checkpoint: bigint, emit: (frame: JournalFrame) => void, onRecord?: (record: OperationRecord) => void): Promise<void> {
  const seen = new Set<string>();
  const header = Buffer.alloc(RECORD_HEADER_BYTES);
  while (true) {
    const headerBytes = await fill(file, header);
    if (headerBytes === 0) return;
    const position = `${summary.file} at byte ${summary.verifiedBytes}`;
    if (headerBytes < header.length) throw new IncompleteRecord(`Incomplete header in ${position}`);
    // The decoder checks the header checksum and body bounds before asking for more bytes.
    const prefix = decodeRecord(header);
    if (prefix.status === 'corrupt') throw new InvalidDataError(`${position}: ${prefix.message}`);
    const recordBytes = Buffer.allocUnsafe(header.length + header.readUInt32LE(0));
    header.copy(recordBytes);
    const body = recordBytes.subarray(header.length);
    if (await fill(file, body) !== body.length) throw new IncompleteRecord(`Incomplete body in ${position}`);
    const decoded = decodeRecord(recordBytes);
    if (decoded.status !== 'ok') throw new InvalidDataError(`${position}: ${decoded.message}`);
    const { sequence, operationId, update } = decoded.record;
    if (sequence !== summary.durableThrough + 1n) throw new InvalidDataError(`${position}: expected sequence ${summary.durableThrough + 1n}, found ${sequence}`);
    if (seen.has(operationId)) throw new InvalidDataError(`${position}: duplicate operation ID ${operationId}`);
    seen.add(operationId);
    onRecord?.(decoded.record);
    summary.firstSequence ??= sequence;
    summary.durableThrough = sequence;
    summary.verifiedBytes += BigInt(decoded.bytesRead);
    if (sequence > checkpoint) {
      summary.tailRecords++;
      emit({ source: 'journal', sequence, update });
    }
  }
}

/** A stopped journal directory or a coherent offline copy. Frames are provisional until integrity is ok. */
export async function inspectJournal(directory: string, onUpdate?: (frame: JournalFrame) => void, onRecord?: (record: OperationRecord) => void): Promise<JournalInspection> {
  const root = resolve(directory);
  const report: JournalInspection = { directory: root, state: 'unknown', integrity: 'ok',
    manifest: null, baseline: null, checkpoint: null, journal: null };
  const emit = (frame: JournalFrame): void => {
    try { onUpdate?.(frame); }
    catch (cause) { throw new ConsumerError('Journal frame rejected by the consumer', {cause}); }
  };
  try {
    const entries = await readdir(root, {withFileTypes: true});
    if (entries.some((entry) => entry.name === 'purged' && entry.isFile())) {
      report.state = 'purged';
      return report;
    }
    const doc = basename(root);
    const manifest = await readManifest(join(root, MANIFEST_FILE_NAME), doc);
    report.manifest = manifest;
    if (!manifest) {
      const orphan = entries.some((entry) => entry.isFile() && (entry.name === 'journal' || entry.name.startsWith('journal.')));
      report.integrity = orphan ? 'corrupt' : 'missing';
      report.issue = orphan ? 'Journal files exist without a published manifest' : 'No published manifest in this directory';
      return report;
    }
    report.state = manifest.seeded ? 'seeded' : 'unseeded';
    if (!manifest.seeded) return report;

    const baseline = baselineName(manifest.generation, manifest.generationFence);
    const { content } = await readSealed(join(root, baseline), BASELINE_MAGIC, doc);
    report.baseline = { file: baseline, frames: 0 };
    // The sealed baseline contains length-prefixed updates, like Go workingset.DecodeFrames.
    for (let offset = 0; offset < content.length;) {
      if (content.length - offset < 4) throw new InvalidDataError(`Incomplete frame prefix in ${baseline}`);
      const length = content.readInt32LE(offset);
      offset += 4;
      if (length < 1 || length > content.length - offset) throw new InvalidDataError(`Invalid frame length in ${baseline}`);
      if (manifest.checkpointThrough === 0n) emit({ source: 'baseline', sequence: 0n, update: content.subarray(offset, offset + length) });
      report.baseline.frames++;
      offset += length;
    }
    if (manifest.checkpointThrough > 0n) {
      const name = checkpointName(manifest.generation, manifest.checkpointThrough, manifest.checkpointFence);
      const sealed = await readSealed(join(root, name), CHECKPOINT_MAGIC, doc);
      if (sealed.tag !== manifest.checkpointThrough) throw new InvalidDataError(`${name} carries sequence ${sealed.tag}, expected ${manifest.checkpointThrough}`);
      report.checkpoint = { file: name, through: sealed.tag };
      emit({ source: 'checkpoint', sequence: sealed.tag, update: sealed.content });
    }
    const name = journalName(manifest.generation, manifest.generationFence);
    report.journal = { file: name, verifiedBytes: 0n, firstSequence: null, durableThrough: 0n, tailRecords: 0n };
    const file = await open(join(root, name), 'r');
    try { await scan(file, report.journal, manifest.checkpointThrough, emit, onRecord); }
    finally { await file.close(); }
    if (manifest.checkpointThrough > report.journal.durableThrough) {
      throw new InvalidDataError(`Checkpoint ${manifest.checkpointThrough} exceeds the journal's last sequence ${report.journal.durableThrough}`);
    }
  } catch (error) {
    if (error instanceof ConsumerError) throw error.cause;
    report.issue = error instanceof Error ? error.message : String(error);
    const cause = error instanceof InvalidDataError && error.cause ? error.cause : error;
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') report.integrity = 'missing';
    else if (error instanceof InvalidDataError) report.integrity = 'corrupt';
    else if (error instanceof IncompleteRecord) {
      report.integrity = 'incomplete';
      if (report.manifest && report.journal && report.manifest.checkpointThrough > report.journal.durableThrough) {
        report.integrity = 'corrupt';
        report.issue += `; checkpoint ${report.manifest.checkpointThrough} exceeds the verified prefix ${report.journal.durableThrough}`;
      }
    } else report.integrity = 'unreadable';
  }
  return report;
}
