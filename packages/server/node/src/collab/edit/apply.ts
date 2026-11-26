/**
 * Applies the three ops POST /edit accepts to a document, the way the Go and
 * C# planners apply them: an `insert` places the block after `after` (null =
 * first) under `parent` (null = the root), an `update` REPLACES the block's
 * data map rather than patching it, and a `remove` takes the block with
 * everything under it. Later ops see what the earlier ones did.
 *
 * Attribution is never invented here. An insert carries the six stamp fields
 * itself — the endpoint stamps them before the digest is taken — and
 * `addBlockAt` writes them with the same per-type filtering as the Go
 * converter, so passing the op's block through preserves them by
 * construction. The one thing the request adds is who made it: an `update`
 * credits the editor the request names, at the ONE instant read for the whole
 * request. A request naming no editor leaves the block's previous author
 * alone, because writing `null` there would erase them.
 */

import { Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { DocumentStore } from '../../../../../../src/components/modules/yjs/document-store.ts';
import { YBlockSerializer } from '../../../../../../src/components/modules/yjs/serializer.ts';
import { htmlToSegmentsNode } from '../../../../../../src/view/rich-text-node.ts';
import type { YjsOutputBlockData } from '../../../../../../src/components/modules/yjs/serializer.ts';
import type { EditCommand, EditValue, InsertCommand, UpdateCommand } from './canonical.ts';

export interface ApplyEditOptions {
  /**
   * The user the request is credited to. Left out, an update keeps whoever
   * the document already names — `updateBlockMetadata` reads a null editor as
   * "nobody made this edit" and deletes the field.
   */
  editor?: string | null;
  /** The agent that edited with `editor`, when one did. */
  coEditor?: string;
  /**
   * Read ONCE for the whole request, so every op of one edit carries the same
   * instant — as the Go endpoint passes `time.Now()` to `StampAuthority` once.
   */
  now?: () => number;
}

/** The six fields an op's block carries, which this applier is never the author of. */
const ATTRIBUTION = [
  'createdAt', 'createdBy', 'createdWith', 'lastEditedAt', 'lastEditedBy', 'lastEditedWith',
] as const;

/** The four that name a person. An anonymous answer carries none of them. */
const SIGNATURE = new Set(['createdBy', 'createdWith', 'lastEditedBy', 'lastEditedWith']);

const asObject = (value: EditValue | undefined): Record<string, EditValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * The stamps the op sent, exactly as it sent them. The block type spells a
 * time as a number, while the endpoint also accepts the `null` Go writes
 * through, so the shape is asserted here rather than narrowed away — the one
 * place in this file that tells the compiler something it cannot see.
 */
function stampsOf(block: Record<string, EditValue>, anonymous: boolean): Partial<YjsOutputBlockData> {
  const kept = ATTRIBUTION.filter(
    (name) => Object.hasOwn(block, name) && !(anonymous && SIGNATURE.has(name))
  );

  return Object.fromEntries(kept.map((name) => [name, block[name] ?? null])) as Partial<YjsOutputBlockData>;
}

function insert(store: DocumentStore, op: InsertCommand): void {
  const type = typeof op.block.type === 'string' ? op.block.type : '';
  const data = asObject(op.block.data);
  // `addBlockAt` does not apply the rule itself: `unsignAnonymousAnswers` runs
  // only from a whole-document load. So it is replayed here, the same way
  // `StoreApplier.insertTree` replays it for the agent.
  const anonymous = (type === 'database-row' && data.anonymous === true) ||
    store.isInAnonymousAnswer(undefined, op.parent);

  store.addBlockAt({
    id: op.id,
    type,
    data,
    ...(Object.hasOwn(op.block, 'tunes') ? { tunes: asObject(op.block.tunes) } : {}),
    ...stampsOf(op.block, anonymous),
  }, { parentId: op.parent, afterId: op.after });
}

function update(store: DocumentStore, op: UpdateCommand, at: number, options: ApplyEditOptions): void {
  const type: unknown = store.getBlockById(op.id)?.get('type');

  // The planner refuses an update of a block the document does not hold; this
  // applier is not the refusing layer, so there is simply nothing to write.
  if (typeof type !== 'string') return;

  store.replaceBlockContent(op.id, type, op.data);

  const editor = options.editor ?? null;

  if (editor === null) return;

  store.updateBlockMetadata(op.id, at, editor, options.coEditor);
}

/** Every block under `id`, following `parentId` — the arbiter of membership, as the Go planner does. */
function subtreeOf(store: DocumentStore, id: string): string[] {
  const children = new Map<string, string[]>();

  for (const block of store.toJSON()) {
    const parent = block.parent;

    if (typeof parent !== 'string' || typeof block.id !== 'string') continue;
    children.set(parent, [...(children.get(parent) ?? []), block.id]);
  }
  const doomed = [id];
  const seen = new Set(doomed);

  // The array grows while it is walked, so a child's children are reached too.
  for (const next of doomed) {
    const kept = (children.get(next) ?? []).filter((child) => !seen.has(child));

    kept.forEach((child) => seen.add(child));
    doomed.push(...kept);
  }

  return doomed;
}

const remove = (store: DocumentStore, id: string): void =>
  subtreeOf(store, id).forEach((gone) => store.removeBlock(gone));

function applyOne(store: DocumentStore, op: EditCommand, at: number, options: ApplyEditOptions): void {
  if (op.op === 'insert') return insert(store, op);
  if (op.op === 'remove') return remove(store, op.id);

  return update(store, op, at, options);
}

/**
 * Applies ops to a store in request order.
 * @param store - the document to write to
 * @param ops - the canonical ops, in the order the request sent them
 * @param options - who the request is credited to, and the clock it reads once
 */
export function applyEditOps(
  store: DocumentStore,
  ops: readonly EditCommand[],
  options: ApplyEditOptions = {}
): void {
  const at = (options.now ?? Date.now)();

  ops.forEach((op) => applyOne(store, op, at, options));
}

/** A store that reads HTML without a DOM, as every server-side projection does. */
const serverStore = (): DocumentStore =>
  new DocumentStore(new YBlockSerializer({ htmlToSegments: htmlToSegmentsNode }));

/**
 * The update that takes a live document through an edit, for a caller holding
 * the room's doc: an `insert ... after` resolves against the document as it is
 * now, so the ops can only be turned into an update inside the room's queue.
 *
 * The same shape as `restorePage`: the edit is planned on a projection of the
 * doc and handed back as the difference, so the caller journals and applies
 * one update and the live doc is not written to on the way.
 * @param doc - the room's live document
 * @param ops - the canonical ops, in the order the request sent them
 * @param options - who the request is credited to, and the clock it reads once
 * @returns the update to journal and apply
 */
export function buildEditUpdate(
  doc: Doc,
  ops: readonly EditCommand[],
  options: ApplyEditOptions = {}
): Uint8Array {
  const store = serverStore();

  try {
    store.applyRemoteUpdate(encodeStateAsUpdate(doc));
    applyEditOps(store, ops, options);

    return store.encodeStateAsUpdate(encodeStateVector(doc));
  } finally {
    store.destroy();
  }
}
