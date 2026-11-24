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
import { timeHistory } from './history-time.ts';
import { deleteArchivedLineage, historyLineages, type HistoryLineage } from './history-lineages.ts';
import { inspectJournal } from '../journal/inspect.ts';
import { MAX_APPEND_BYTES } from '../journal/append.ts';
import { exportPage, restorePage } from './page-document.ts';

interface Version {
  lineage: string;
  sequence: number;
  startedAt: number | null;
  savedAt: number | null;
  actors: string[];
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

function changeSet(before: Page, after: Page) {
  const diff = diffOutput(before, after, { htmlToSegments: htmlToSegmentsNode });
  const blocks = [
    ...diff.added.map((after) => ({ kind: 'added', id: after.id, type: after.type, after })),
    ...diff.removed.map((before) => ({ kind: 'removed', id: before.id, type: before.type, before })),
    ...diff.changed.map(({ before, after, id }) => ({ kind: 'changed', id, type: after.type, before, after })),
    ...diff.moved.map(({ before, after, id }) => ({ kind: 'moved', id, type: after.type, before, after })),
  ];
  const page = ['title', 'icon', 'cover'].filter((key) => !isDeepStrictEqual(before[key], after[key]));
  return { blocks, page };
}

// Early releases recorded a session digest as an actor. Never expose an internal session handle.
function publicActor(id: string | null) {
  return id && /^(?:mcp:)?[a-f0-9]{64}$/.test(id)
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
}): Promise<Result> {
  const { directory, doc, tag, head, request, operations } = input;
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
  const rows: unknown[] = [];
  const replay = new Doc();
  const publicHead = (sequence: bigint) => ({
    'Blok-Doc-Lineage': tag.lineage,
    'Blok-Doc-Sequence': String(sequence),
    ETag: '"' + tag.lineage + ':' + sequence + '"',
  });
  const revision = tag.lineage + ':' + head;
  const key = request.key;
  const operationId = key && createHash('sha256').update(key).digest('hex').slice(0, 32);
  const digest = createHash('sha256')
    .update('restore\n' + lineage + '\n' + through + (keep ? '\nkeep' : ''))
    .digest();
  if (restore) {
    if (!sub && (!key || !/^[\x20-\x7e]{1,128}$/.test(key))) return { status: 400 };
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
    let actor: string | null = null,
      time = 0;
    const floor = changes ? BigInt(since) : 0n;
    // Bound expensive before/after projections to the most recent 64 requested records.
    const start = changes && through - floor > 64n ? through - 64n : floor;
    async function readLineage(entry: HistoryLineage) {
      const lineage = entry.manifest.lineage;
      const grouped: Version[] = [];
      previousActor = null;
      const info = await inspectJournal(
        directory,
        (frame) => {
          if (list || frame.sequence > through) return;
          if (changes && frame.sequence > start) prior = project(replay);
          applyUpdate(replay, frame.update);
          if (changes && frame.sequence > start && prior) {
            const change = changeSet(prior, project(replay));
            if (q.has('block')) {
              change.blocks = change.blocks.filter((b) => b.id === q.get('block'));
              change.page = [];
              if (!change.blocks.length) return;
            }
            rows.push({ sequence: Number(frame.sequence), committedAt: time, actor, ...change });
          }
        },
        (record) => {
          time = Number((record.committedAtTicks - 621355968000000000n) / 10000n);
          actor = publicActor(record.actorId);
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
              actors: [],
            };
            grouped.push(current);
          }
          current.savedAt = time;
          current.sequence = Number(record.sequence);
          if (actor && !current.actors.includes(actor)) current.actors.push(actor);
          previousActor = actor;
        },
        true,
        entry.manifest,
      );
      if (info.integrity !== 'ok' || !info.journal || (entry.current && info.journal.durableThrough !== head))
        throw new Error('Inconsistent history');
      if (list) {
        const createdAt = entry.createdAt ?? grouped[0]?.startedAt ?? null;
        versions.push(...grouped.reverse(), {
          lineage,
          sequence: 0,
          startedAt: createdAt,
          savedAt: createdAt,
          actors: [],
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
        body: {
          changes: rows,
          truncated: start > floor,
          ...(start > floor && { olderEnd: { lineage, sequence: Number(start + 1n) } }),
        },
      };
    let target = project(replay);
    if (!restore) {
      const page = Object.fromEntries(
        ['title', 'icon', 'cover'].filter((k) => k in target).map((k) => [k, target[k]]),
      );
      return { status: 200, headers, body: { blocks: target.blocks, page } };
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
