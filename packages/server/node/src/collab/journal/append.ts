import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { applyUpdate, Doc } from 'yjs';
import { MANIFEST_FILE_NAME, readManifest, type JournalManifest } from './files.ts';
import { inspectJournal, type JournalFrame } from './inspect.ts';
import { encodeRecord, type OperationSource, type OperationRecord } from './record.ts';

export interface AppendRequest {
  expectedLineage: string;
  expectedThrough: bigint;
  operationId: string;
  actorId: string | null;
  source: OperationSource;
  update: Uint8Array;
  /** Go's HTTP edit engine hashes the canonical command body, not the generated Yjs update. */
  digest?: Uint8Array;
}
export interface AppendResult {
  outcome: 'committed' | 'duplicate' | 'conflict' | 'stale';
  sequence: bigint;
}
export const MAX_APPEND_BYTES = 1024 * 1024;

const flock = `import errno, fcntl, sys
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as error:
    if error.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
        sys.exit(75)
    raise`;

// POSIX flock belongs to the shared open file description. Python takes the
// lock through inherited fd 3 and exits; Node owns it until handle.close().
async function lockDocument(handle: FileHandle): Promise<void> {
  await new Promise<void>((ok, fail) => {
    const child = spawn('python3', ['-I', '-S', '-c', flock], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
    child.once('error', cause => fail(new Error('Cannot acquire the journal flock (python3 required)', { cause })));
    child.once('close', (code) => {
      if (code === 0) ok();
      else if (code === 75) fail(Object.assign(new Error('Journal held by another writer'), {code:'JOURNAL_BUSY'}));
      else fail(new Error('Failed to acquire the journal flock'));
    });
  });
}

async function sameFile(path: string, handle: FileHandle) {
  const [named, held] = await Promise.all([lstat(path, { bigint:true }), handle.stat({ bigint:true })]);
  if (!held.isFile() || named.dev !== held.dev || named.ino !== held.ino) throw new Error('Journal file ownership changed');
}

async function verifyFence(directory: string, hold: FileHandle, manifest: JournalManifest) {
  await sameFile(join(directory, 'lock'), hold);
  const current = await readManifest(join(directory, MANIFEST_FILE_NAME), basename(directory));
  if (!current || current.writeCounter !== manifest.writeCounter || current.fence !== manifest.fence ||
      current.lineage !== manifest.lineage || current.generation !== manifest.generation || current.generationFence !== manifest.generationFence) {
    throw new Error('Journal manifest changed under lock');
  }
}

function requireComplete(doc: Doc) {
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) throw new Error('Unresolved Yjs dependencies');
}

async function writeAndSync(file: FileHandle, bytes: Uint8Array, position: number, check: () => Promise<void>) {
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, position + offset);
      if (!bytesWritten) throw new Error('Journal write made no progress');
      offset += bytesWritten;
    }
    await file.sync();
  } catch (error) {
    // A failed fsync can leave readable bytes in cache. They must not become
    // an acknowledged duplicate on retry. Never roll back another holder.
    await check();
    await file.truncate(position);
    await file.sync();
    throw error;
  }
  await check();
}

function validateRequest(request: AppendRequest): Buffer {
  if (!/^[a-f0-9]{32}$/.test(request.expectedLineage) || !/^[a-f0-9]{32}$/.test(request.operationId)) {
    throw new Error('Expected 32 lowercase hex characters for lineage and operation ID');
  }
  if (typeof request.expectedThrough !== 'bigint' || request.expectedThrough < 0n || request.expectedThrough >= 1n << 64n) {
    throw new Error('Expected head must fit uint64');
  }
  if (!(request.update instanceof Uint8Array) || !request.update.length || request.update.length > MAX_APPEND_BYTES) {
    throw new RangeError('Journal update must contain 1 byte to 1 MiB');
  }
  if (request.source === 2) {
    if (!(request.digest instanceof Uint8Array) || request.digest.length !== 32) throw new Error('HTTP edit requires its canonical command digest');
    return Buffer.from(request.digest);
  }
  if (request.source !== 0 && request.source !== 1) throw new Error('Unknown operation source');
  const digest = createHash('sha256').update(request.update).digest();
  if (request.digest && !digest.equals(request.digest)) throw new Error('Client update digest mismatch');
  return digest;
}

async function appendHeld(root: string, hold: FileHandle, request: AppendRequest, digest: Buffer): Promise<AppendResult> {
  const flags = constants.O_RDWR | constants.O_NOFOLLOW;
  const doc = new Doc();
  try {
    let existing: AppendResult | undefined;
    const report = await inspectJournal(root, frame => applyUpdate(doc, frame.update), record => {
      if (record.operationId === request.operationId) {
        existing = { outcome: digest.equals(record.digest) ? 'duplicate' : 'conflict', sequence: record.sequence };
      }
    });
    const { manifest, journal } = report;
    if (report.state !== 'seeded' || !manifest || !journal || (report.integrity !== 'ok' && report.integrity !== 'incomplete')) {
      throw new Error(`Cannot append (state=${report.state}, integrity=${report.integrity}): ${report.issue ?? ''}`);
    }
    requireComplete(doc);
    const head = journal.durableThrough;
    if (manifest.lineage !== request.expectedLineage) return { outcome:'stale', sequence:head };
    if (!existing && head !== request.expectedThrough) return { outcome:'stale', sequence:head };

    const path = join(root, journal.file);
    const file = await open(path, flags);
    try {
      const check = async () => { await verifyFence(root, hold, manifest); await sameFile(path, file); };
      await check();
      if (existing) {
        if (existing.outcome === 'duplicate') await file.sync();
        await check();
        return existing;
      }
      applyUpdate(doc, request.update);
      requireComplete(doc);
      const position = Number(journal.verifiedBytes);
      if (!Number.isSafeInteger(position)) throw new RangeError('Journal offset exceeds the supported file size');
      const sequence = head + 1n;
      const bytes = encodeRecord({ ...request, digest, sequence, committedAtTicks: 621355968000000000n + BigInt(Date.now()) * 10000n });
      if (report.integrity === 'incomplete') {
        await file.truncate(position);
        await file.sync();
      }
      await writeAndSync(file, bytes, position, check);
      return { outcome:'committed', sequence };
    } finally { await file.close(); }
  } finally { doc.destroy(); }
}

/** Keep the Go-compatible lease until all scheduled commits settle and close() resolves. */
export async function acquireJournalWriter(directory: string) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Journal writing requires macOS or Linux flock');
  const root = resolve(directory);
  if (!(await lstat(join(root, MANIFEST_FILE_NAME))).isFile()) throw new Error('Expected an existing journal manifest');
  const hold = await open(join(root, 'lock'), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CREAT, 0o600);
  try {
    await lockDocument(hold);
    await sameFile(join(root, 'lock'), hold);
  } catch (error) {
    await hold.close();
    throw error;
  }
  let pending = Promise.resolve();
  let closing: Promise<void> | undefined;
  function schedule<T>(job: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error('Journal writer closed'));
    const result = pending.then(job);
    pending = result.then(() => {}, () => {});
    return result;
  }
  return {
    recover(onUpdate: (frame: JournalFrame) => void, onRecord: (record: OperationRecord) => void) {
      return schedule(async () => {
        const report = await inspectJournal(root, onUpdate, onRecord);
        const { manifest, journal } = report;
        if (!manifest || !journal || report.state !== 'seeded' || !['ok','incomplete'].includes(report.integrity)) {
          throw new Error('Cannot recover journal: ' + (report.issue ?? report.state));
        }
        const path = join(root, journal.file);
        const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          await verifyFence(root, hold, manifest);
          await sameFile(path, file);
          if (report.integrity === 'incomplete') {
            const position = Number(journal.verifiedBytes);
            if (!Number.isSafeInteger(position)) throw new RangeError('Journal offset exceeds the supported file size');
            await file.truncate(position);
          }
          // A previous process may have died after write() and before fsync().
          // Stabilize the verified prefix before a new room can acknowledge it.
          await file.sync();
          await verifyFence(root, hold, manifest);
          await sameFile(path, file);
          return { manifest, journal };
        } finally { await file.close(); }
      });
    },
    append(input: AppendRequest): Promise<AppendResult> {
      if (closing) return Promise.reject(new Error('Journal writer closed'));
      const digest = validateRequest(input);
      const request = { ...input, update: Uint8Array.from(input.update) };
      return schedule(() => appendHeld(root, hold, request, digest));
    },
    close(): Promise<void> {
      return closing ??= pending.then(() => hold.close());
    },
  };
}

/** Append to an already-seeded canonical directory on a local POSIX filesystem. */
export async function appendJournal(directory: string, input: AppendRequest): Promise<AppendResult> {
  const writer = await acquireJournalWriter(directory);
  try { return await writer.append(input); }
  finally { await writer.close(); }
}
