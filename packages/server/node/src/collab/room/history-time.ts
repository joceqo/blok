import { applyUpdate, Doc } from 'yjs';
import { inspectJournal } from '../journal/inspect.ts';
import type { HistoryLineage } from './history-lineages.ts';

interface Point {
  lineage: string;
  sequence: number;
  committedAt: number;
}
const day = 86400000;
const utcEpoch = 621355968000000000n;
function timeParam(q: URLSearchParams, key: string, defaultTime: number) {
  const values = q.getAll(key);
  if (!values.length) return defaultTime;
  const value = values[0]!;
  if (values.length !== 1 || !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)$/.test(value))
    return NaN;
  return Date.parse(value);
}

export async function timeHistory<T>(
  directory: string,
  entries: HistoryLineage[],
  url: URL,
  asJSON: boolean,
  project: (d: Doc) => T,
  changes: (before: T, after: T) => { blocks: { id?: string }[]; page: string[] },
  actorName: (id: string | null) => string | null,
) {
  const q = url.searchParams;
  const atTime = url.pathname.endsWith('/at');
  const at = timeParam(q, 'time', NaN),
    to = timeParam(q, 'to', Date.now()),
    from = timeParam(q, 'from', to - day);
  if (atTime ? !Number.isFinite(at) : !Number.isFinite(from + to) || from > to) return { status: 400 };
  const before = q.get('before')?.match(/^([\da-f]{32}):(0|[1-9]\d*)$/);
  if (!atTime && q.has('before') && (!before || q.getAll('before').length !== 1)) return { status: 400 };
  const beforeIndex = before ? entries.findIndex((e) => e.manifest.lineage === before[1]) : 0;
  if (beforeIndex < 0) return { status: 404 };
  let best: Point | undefined;
  const selected: Point[] = [];
  const max = 64;
  let truncated = false;
  // Read newest generation first. The room queue holds its writer across both passes.
  for (let i = beforeIndex; i < entries.length; i++) {
    const entry = entries[i]!,
      lineage = entry.manifest.lineage;
    const recent: Point[] = [];
    function consider(sequence: bigint, time: number) {
      const point = { lineage, sequence: Number(sequence), committedAt: time };
      if (atTime) {
        if (
          time <= at &&
          (!best ||
            time > best.committedAt ||
            (time === best.committedAt && lineage === best.lineage && point.sequence > best.sequence))
        )
          best = point;
      } else if (
        sequence > 0n &&
        time >= from &&
        time < to &&
        !(before && i === beforeIndex && sequence >= BigInt(before[2]!))
      ) {
        recent.push(point);
        if (recent.length > max) {
          recent.shift();
          truncated = true;
        }
      }
    }
    if (entry.createdAt !== null) consider(0n, entry.createdAt);
    const report = await inspectJournal(
      directory,
      undefined,
      (r) => consider(r.sequence, Number((r.committedAtTicks - utcEpoch) / 10000n)),
      true,
      entry.manifest,
    );
    if (report.integrity !== 'ok') throw new Error('Inconsistent historical journal');
    selected.push(...recent.reverse());
    if (selected.length > max) {
      selected.length = max;
      truncated = true;
      break;
    }
  }
  if (atTime) {
    if (!best) return { status: 404, body: { reason: 'not_found' } };
    const headers: Record<string, string> = {
      'Blok-History-Lineage': best.lineage,
      'Blok-History-Sequence': String(best.sequence),
    };
    if (asJSON) return { status: 200, headers, body: best };
    headers.Location = best.lineage + '/' + best.sequence;
    return { status: 302, headers };
  }
  const rows = new Map<string, unknown>();
  for (const entry of entries) {
    const lineage = entry.manifest.lineage;
    const points = selected.filter((p) => p.lineage === lineage);
    if (!points.length) continue;
    const wanted = new Map(points.map((p) => [p.sequence, p]));
    const doc = new Doc();
    let actor: string | null = null;
    try {
      const report = await inspectJournal(
        directory,
        (frame) => {
          if (frame.sequence > BigInt(points[0]!.sequence)) return;
          const point = wanted.get(Number(frame.sequence));
          const old = point && project(doc);
          applyUpdate(doc, frame.update);
          if (point && old) {
            const diff = changes(old, project(doc));
            if (q.has('block')) {
              diff.blocks = diff.blocks.filter((b) => b.id === q.get('block'));
              diff.page = [];
              if (!diff.blocks.length) return;
            }
            rows.set(lineage + ':' + point.sequence, { ...point, actor, ...diff });
          }
        },
        (r) => {
          actor = actorName(r.actorId);
        },
        true,
        entry.manifest,
      );
      if (report.integrity !== 'ok') throw new Error('Inconsistent historical journal');
    } finally {
      doc.destroy();
    }
  }
  return {
    status: 200,
    body: {
      changes: selected.flatMap((p) => {
        const row = rows.get(p.lineage + ':' + p.sequence);
        return row ? [row] : [];
      }),
      truncated,
      ...(truncated && { olderEnd: selected.at(-1) }),
    },
  };
}
