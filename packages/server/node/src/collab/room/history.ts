import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyUpdate, Doc } from 'yjs';
import type { OutputData } from '../../../../../../types/data-formats/output-data.ts';
import { keepDatabases } from './keep-databases.ts';
import { diffOutput } from '../../../../../../src/shared/output-diff.ts';
import { htmlToSegmentsNode } from '../../../../../../src/view/rich-text-node.ts';
import {
  lockedDatabases,
  restoreShares,
  restoreTouchesLocked,
} from '../../../../../../src/shared/agent/approval.ts';
import { DocSnapshot } from '../../../../../../src/shared/agent/snapshot.ts';
import { HistoryChangeWindow, maxHistoryChangeRecords, type ChangePoint } from './history-change-window.ts';
import { changeQuery, databaseChangeDetails } from './database-changes.ts';
import { readRecordNotes, recordActor, type HistoryActor } from './record-notes.ts';
import { timeHistory } from './history-time.ts';
import { deleteArchivedLineage, historyLineages, type HistoryLineage } from './history-lineages.ts';
import { inspectJournal } from '../journal/inspect.ts';
import { MAX_APPEND_BYTES } from '../journal/append.ts';
import { exportPage, restorePage } from './page-document.ts';
import { operationIdForKey } from '../edit/canonical.ts';
import { restoreDigest } from '../edit/restore-digest.ts';

interface Version {
  lineage: string;
  sequence: number;
  startedAt: number | null;
  savedAt: number | null;
  actors: string[];
  actorKinds: HistoryActor[];
}
interface Request {
  asJSON?: boolean;
  url: URL;
  method: string;
  key?: string;
  match?: string;
  confirmed: string[];
}
export type HistoryRequest = Request;
type Page = Record<string, unknown> & OutputData;
type Result = { status: number; body?: unknown; headers?: Record<string, string> };

function changeSet(before: Page, after: Page, properties = false) {
  const diff = diffOutput(before, after, { htmlToSegments: htmlToSegmentsNode });
  const blocks = [
    ...diff.added.map((after) => ({ kind: 'added', id: after.id, type: after.type, after })),
    ...diff.removed.map((before) => ({ kind: 'removed', id: before.id, type: before.type, before })),
    ...diff.changed.map(({ before, after, id }) => ({
      kind: 'changed', id, type: after.type, before, after,
      ...(properties && databaseChangeDetails(after.type, before, after)),
    })),
    ...diff.moved.map(({ before, after, id }) => ({ kind: 'moved', id, type: after.type, before, after })),
  ];
  const page = ['title', 'icon', 'cover'].filter((key) => !isDeepStrictEqual(before[key], after[key]));
  return { blocks, page };
}

// Early releases recorded a session digest as an actor. Never expose an internal session handle.
// A record written without an actor reads as null, never as the empty string.
function publicActor(id: string | null) {
  if (!id) return null;
  return /^(?:mcp:)?[a-f0-9]{64}$/.test(id)
    ? 'actor-' + createHash('sha256').update(id).digest('hex').slice(0, 16)
    : id;
}

export async function historyRequest(input: {
  directory: string;
  doc: Doc;
  tag: { lineage: string; epoch: number; format: number };
  head: bigint;
  request: Request;
  project?: (doc: Doc) => Record<string, unknown>;
  operations: Map<string, { sequence: bigint; digest: Buffer }>;
  commit: (operationId: string, digest: Buffer, update: Uint8Array) => Promise<bigint>;
  /**
   * A record-notes store answers for this document: every changes row then
   * carries `actors`, empty when that record has no note. A host running
   * without such a store passes false, and no row names actors at all.
   */
  recordNotes?: boolean;
}): Promise<Result> {
  const { directory, doc, tag, head, request, operations } = input;
  const recordNotes = input.recordNotes ?? true;
  const { url, method } = request;
  const project = (d: Doc) => (input.project?.(d) ?? exportPage(d, {})) as Page;
  if (url.pathname.split('/').length === 6 && url.pathname.endsWith('/state')) {
    if (method !== 'GET') return { status: 405 };
    return {
      status: 200,
      body: project(doc),
      headers: {
        'Blok-Doc-Lineage': tag.lineage,
        'Blok-Doc-Sequence': String(head),
        ETag: '"' + tag.lineage + ':' + head + '"',
      },
    };
  }
  const lineages = await historyLineages(directory);
  const path = url.pathname.split('/').slice(6);
  const [lineage, point, action, sub] = path;
  const list = path.length === 0;
  if (path.length === 1 && (lineage === 'at' || lineage === 'changes')) {
    if (method !== 'GET') return { status: 405 };
    return timeHistory(directory, lineages, url, !!request.asJSON, project, changeSet, publicActor);
  }
  const active = lineages.find((entry) => entry.current);
  const selected = list ? active : lineages.find((entry) => entry.manifest.lineage === lineage);
  if (!selected) return { status: 404 };
  if (method === 'DELETE' && path.length === 1) {
    if (!active || !selected) return { status: 404 };
    return { status: (await deleteArchivedLineage(directory, selected, active)) ? 204 : 409 };
  }
  const changes = action === 'changes';
  const restore = action === 'restore';
  if (list && method !== 'GET') return { status: 405 };
  if (!list && (!point || !/^(0|[1-9][0-9]*)$/.test(point))) return { status: 404 };
  if (path.length > 4 || (sub && !(restore && sub === 'preview')) || (action && !changes && !restore))
    return { status: 404 };
  if (method !== (restore ? 'POST' : 'GET')) return { status: 405 };
  const through = point ? BigInt(point) : head;
  if (selected.current && through > head) return { status: 404 };
  const q = url.searchParams;
  const { properties, blockId } = changeQuery(q);
  const group = q.get('group');
  if (list && (q.getAll('group').length > 1 || (group !== null && !['1', '15', '60'].includes(group))))
    return { status: 400 };
  const since = q.get('since') ?? '0';
  if (changes && (!/^(0|[1-9][0-9]*)$/.test(since) || BigInt(since) > through)) return { status: 400 };
  const keep = restore && q.get('databases') === 'keep';
  if (
    restore &&
    (q.getAll('databases').length > 1 || (q.has('databases') && !keep && q.get('databases') !== 'restore'))
  )
    return { status: 400 };
  const versions: Version[] = [];
  const rows = new HistoryChangeWindow();
  let oldestRead: ChangePoint | undefined;
  const replay = new Doc();
  // The point's own time: the record the path names, not the newest one read.
  const pointTime = { at: null as number | null };
  const publicHead = (sequence: bigint) => ({
    'Blok-Doc-Lineage': tag.lineage,
    'Blok-Doc-Sequence': String(sequence),
    ETag: '"' + tag.lineage + ':' + sequence + '"',
  });
  const revision = tag.lineage + ':' + head;
  const key = request.key;
  const operationId = key === undefined ? null : operationIdForKey(key);
  // The path segment and the manifest agree: `selected` was found by matching it.
  const digest = restoreDigest(selected.manifest.lineage, through, keep);
  if (restore) {
    // No operation id means no usable key: either none was sent, or it is not one.
    if (!sub && !operationId) return { status: 400 };
    if (!sub && operationId) {
      const prior = operations.get(operationId);
      if (prior)
        return prior.digest.equals(digest)
          ? { status: 204, headers: publicHead(prior.sequence) }
          : { status: 409 };
    }
    if (request.match && !/^"[a-f0-9]{32}:(0|[1-9][0-9]*)"$/.test(request.match)) return { status: 400 };
    if (request.match && request.match !== '"' + revision + '"')
      return { status: 412, headers: publicHead(head) };
  }
  try {
    let previousActor: string | null = null;
    let prior: Page | undefined;
    let noted: HistoryActor | undefined;
    let actor: string | null = null,
      time = 0;
    const floor = changes ? BigInt(since) : 0n;
    const maxRecords = BigInt(maxHistoryChangeRecords);
    const start = changes && through - floor > maxRecords ? through - maxRecords : floor;
    async function readLineage(entry: HistoryLineage) {
      const lineage = entry.manifest.lineage;
      const grouped: Version[] = [];
      const notes = list || changes ? await readRecordNotes(directory,lineage) : new Map();
      previousActor = null;
      const info = await inspectJournal(
        directory,
        (frame) => {
          if (list || frame.sequence > through) return;
          if (changes && frame.sequence > start) prior = project(replay);
          applyUpdate(replay, frame.update);
          if (changes && frame.sequence > start && prior) {
            const point = { lineage, sequence: Number(frame.sequence), committedAt: time };
            oldestRead ??= point;
            const change = changeSet(prior, project(replay), properties);
            if (blockId !== undefined) {
              change.blocks = change.blocks.filter((b) => b.id === blockId);
              change.page = [];
              if (!change.blocks.length) return;
            }
            rows.add(point, {
              sequence: point.sequence,
              committedAt: time,
              actor,
              ...(recordNotes && { actors: noted ? [noted] : [] }),
              blocks: change.blocks,
              ...(change.page.length > 0 && { page: change.page }),
            });
          }
        },
        (record) => {
          time = Number((record.committedAtTicks - 621355968000000000n) / 10000n);
          if (record.sequence === through) pointTime.at = time;
          actor = publicActor(record.actorId);
          noted = recordActor(notes,record,actor);
          if (!list) return;
          const gap = group ? Number(group) * 60000 : 120000;
          const span = group ? Number(group) * 60000 : 600000;
          let current = grouped.at(-1);
          if (
            !current ||
            time - current.savedAt! > gap ||
            time - current.startedAt! >= span ||
            (q.get('by') === 'actor' && previousActor !== actor)
          ) {
            current = {
              lineage,
              sequence: Number(record.sequence),
              startedAt: time,
              savedAt: time,
              actors: [], actorKinds: [],
            };
            grouped.push(current);
          }
          current.savedAt = time;
          current.sequence = Number(record.sequence);
          if (actor && !current.actors.includes(actor)) current.actors.push(actor);
          if (noted && !current.actorKinds.some(entry => entry.id === noted!.id)) current.actorKinds.push(noted);
          previousActor = actor;
        },
        true,
        entry.manifest,
      );
      if (info.integrity !== 'ok' || !info.journal || (entry.current && info.journal.durableThrough !== head))
        throw new Error('Inconsistent history');
      if (list) {
        const createdAt = entry.createdAt ?? grouped[0]?.startedAt ?? null;
        for (const version of grouped) {
          // An older occurrence of this actor may predate note recording.
          const byId = new Map(version.actorKinds.map(note => [note.id, note]));
          version.actorKinds = version.actors.flatMap(id => byId.get(id) ?? []);
        }
        versions.push(...grouped.reverse(), {
          lineage,
          sequence: 0,
          startedAt: createdAt,
          savedAt: createdAt,
          actors: [], actorKinds: [],
        });
      }
      return info.journal.durableThrough;
    }
    if (list) {
      for (const entry of lineages) await readLineage(entry);
      return {
        status: 200,
        body: {
          lineages: lineages.map(({ manifest, current, createdAt }) => ({
            lineage: manifest.lineage,
            epoch: Number(manifest.epoch),
            format: manifest.format,
            current,
            createdAt,
          })),
          versions,
        },
      };
    }
    const available = await readLineage(selected);
    if (through > available) return { status: 404 };
    const headers = {
      'Blok-History-Lineage': selected.manifest.lineage,
      'Blok-History-Sequence': String(through),
    };
    if (changes)
      return {
        status: 200,
        headers,
        body: rows.result(start > floor ? oldestRead : undefined, false),
      };
    let target = project(replay);
    if (!restore) {
      const page = Object.fromEntries(
        ['title', 'icon', 'cover'].filter((k) => k in target).map((k) => [k, target[k]]),
      );
      // Sequence 0 is the lineage's birth; it has no record of its own.
      const at = through === 0n ? selected.createdAt : pointTime.at;
      return { status: 200, headers, body: { blocks: target.blocks, page, ...(at !== null && { time: at }) } };
    }
    const now = project(doc);
    const kept = keep ? keepDatabases(now, target) : undefined;
    if (kept) target = { ...target, blocks: kept.blocks };
    const update = restorePage(doc, target);
    const before = DocSnapshot.fromOutput(now);
    const lockedTarget = new Set(lockedDatabases(DocSnapshot.fromOutput(target)));
    const lockedNow = new Set(lockedDatabases(before));
    const guards = [
      ...restoreTouchesLocked(before, target)
        .filter((id) => !kept?.pinned.has(id))
        .map((blockId) => ({
          kind: lockedNow.has(blockId) && !lockedTarget.has(blockId) ? 'unlock' : 'lockedReshape',
          blockId,
        })),
      ...restoreShares(before, target)
        .filter((g) => !kept?.pinned.has(g.blockId))
        .map(({ blockId, viewId }) => ({ kind: 'share', blockId, viewId })),
    ];
    for (const blockId of kept?.orphans ?? []) guards.push({ kind: 'orphanedDatabase', blockId });
    if (sub) {
      const { blocks, page } = changeSet(now, target);
      return {
        status: 200,
        body: {
          wouldUndo: { blocks: blocks.map(({ id, type, kind }) => ({ id, type, kind })), page },
          guards,
          fits: update.length <= MAX_APPEND_BYTES,
          frameBytes: update.length,
          limitBytes: MAX_APPEND_BYTES,
          expectRevision: revision,
        },
      };
    }
    if (guards.some((g) => g.kind === 'orphanedDatabase' || !request.confirmed.includes(g.kind)))
      return { status: 409, headers: { 'X-Blok-Restore-Refusal': 'guards' }, body: { guards } };
    if (update.length > MAX_APPEND_BYTES) return { status: 413 };
    const sequence = await input.commit(operationId!, digest, update);
    return { status: 204, headers: publicHead(sequence) };
  } finally {
    replay.destroy();
  }
}
