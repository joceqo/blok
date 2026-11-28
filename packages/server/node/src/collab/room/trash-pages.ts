import type { OutputData, OutputBlockData } from '../../../../../../types/data-formats/output-data.ts';

/** Who restored and when, in milliseconds since the epoch. A restore with no actor stamps a null `by`. */
export interface RestoreTrash {
  by: string | null;
  at: number;
}

type Block = OutputBlockData & { id: string };
type Slot = { parent: string; index: number; block: Block };
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIdOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

/**
 * The page tool's `readTrashed` check (`src/tools/page/index.ts`), so a value
 * the editor would drop is stamped afresh here rather than left to rot.
 */
function isTrashed(value: unknown): boolean {
  if (!isObject(value)) return false;
  const { at, by, formerParentId, formerIndex } = value;
  if (typeof at !== 'number' || !Number.isFinite(at) || !isIdOrNull(by) || !isIdOrNull(formerParentId)) return false;
  return typeof formerIndex === 'number' && Number.isInteger(formerIndex) && formerIndex >= 0;
}

/** The live blocks by id, in document order, each with its position among its siblings. */
function liveSlots(blocks: OutputBlockData[]): Map<string, Slot> {
  const slots = new Map<string, Slot>();
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (typeof block.id !== 'string') continue;
    const parent = block.parent ?? '';
    const taken = counts.get(parent) ?? 0;
    counts.set(parent, taken + 1);
    // A repeated id is one block; the first copy names its slot.
    if (!slots.has(block.id)) slots.set(block.id, { parent, index: taken, block: block as Block });
  }
  return slots;
}

/**
 * Where in `target` a pointer goes so that, among the target's children of
 * `parent`, it follows every sibling that sat before it in the live document.
 */
function slotAmongSiblings(
  target: OutputBlockData[],
  parent: string,
  slots: Map<string, Slot>,
  index: number,
): number {
  const siblings = target.flatMap((block, position) => ((block.parent ?? '') === parent ? [{ block, position }] : []));
  const preceding = siblings.flatMap(({ block, position }) => {
    const live = typeof block.id === 'string' ? slots.get(block.id) : undefined;
    return live !== undefined && live.parent === parent && live.index < index ? [position + 1] : [];
  });
  if (preceding.length > 0) return Math.max(...preceding);
  return siblings.at(0)?.position ?? target.length;
}

/**
 * The target a restore writes with `CollabRestoreTrashesPages` on: every live
 * page pointer the target lacks, kept with `data.trashed` set, so the sub-page
 * is not cut off from the document that points at it.
 *
 * A pointer keeps its place among its live siblings; one whose parent the
 * target lacks goes to the end of the root. A pointer already trashed keeps
 * the stamps it carries.
 */
export function trashPages(live: OutputData, target: OutputData, trash: RestoreTrash): OutputBlockData[] {
  const ids = new Set(target.blocks.flatMap((block) => (typeof block.id === 'string' ? [block.id] : [])));
  const slots = liveSlots(live.blocks);
  const blocks: OutputBlockData[] = target.blocks.map((block) => structuredClone(block));

  for (const [id, slot] of slots) {
    const { block } = slot;
    if (block.type !== 'page' || ids.has(id)) continue;
    ids.add(id);

    const former = block.parent;
    const data: JsonObject = isObject(block.data) ? structuredClone(block.data) : {};
    if (!isTrashed(data.trashed)) {
      data.trashed = { at: trash.at, by: trash.by, formerParentId: former ?? null, formerIndex: slot.index };
    }
    // The restore rebuilds containment from the parent links, so a pointer
    // carries neither its live children nor a parent the target does not hold.
    const { parent: _parent, content: _content, data: _data, ...rest } = block;
    const orphaned = former !== undefined && !ids.has(former);
    const pointer: OutputBlockData = { ...rest, ...(!orphaned && former !== undefined && { parent: former }), data };

    if (orphaned) blocks.push(pointer);
    else blocks.splice(slotAmongSiblings(blocks, former ?? '', slots, slot.index), 0, pointer);
  }
  return blocks;
}
