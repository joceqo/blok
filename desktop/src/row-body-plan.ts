import type { OutputBlockData, OutputData } from '../../types';

/**
 * Moving a row's body out of its page, as a pure function.
 *
 * A local row keeps its body as child blocks of the `database-row` block,
 * inside the host page's file. A row on a server is a document of its own, and
 * everything downstream keys off that: mounting the body, looking it up,
 * duplicating it, and the page actions — rename, duplicate, delete — which have
 * nothing to act on while the body is a handful of blocks in someone else's
 * file.
 *
 * This is the TypeScript port of `planRowBody` (apps/service/row_bodies.go),
 * kept pure for the same reason the Go one is: it computes both documents and
 * writes neither, so the caller orders the writes and can refuse the whole move
 * on any error without having touched a file.
 */

export class RowBodyPlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RowBodyPlanError';
  }
}

export interface RowBodyPlan {
  /** The host page without the moved blocks, its row now naming the body. */
  source: OutputData;
  /** The body document: the moved subtree, its roots detached from the row. */
  body: OutputData;
  /** Every block that moved, in pre-order. */
  descendantIds: string[];
  /** The row already names this page and has no body left to move. */
  alreadyMoved: boolean;
}

type Block = OutputBlockData & { id?: string; parent?: string; content?: string[]; data?: Record<string, unknown> };

const refuse = (message: string): never => { throw new RowBodyPlanError(message); };

/** Every child a block claims, validated on its own so the walk below stays flat. */
const readContent = (block: Block): string[] => {
  if (block.content === undefined || block.content === null) return [];
  if (!Array.isArray(block.content)) refuse(`block ${String(block.id)} has unusable content`);
  const seen = new Set<string>();

  for (const child of block.content) {
    if (typeof child !== 'string' || child === '' || seen.has(child)) refuse(`block ${String(block.id)} lists a child twice`);
    seen.add(child);
  }

  return [...block.content];
};

const readParent = (block: Block): string | null => {
  if (block.parent === undefined || block.parent === null) return null;
  if (typeof block.parent !== 'string' || block.parent === '') refuse(`block ${String(block.id)} has an unusable parent`);

  return block.parent;
};

interface Tree {
  byId: Map<string, Block>;
  parents: Map<string, string>;
  children: Map<string, string[]>;
}

/** Both directions have to agree: a half-written link is how blocks get lost. */
const crossCheck = (tree: Tree): void => {
  const listedBy = new Map<string, string>();

  for (const [id, ids] of tree.children) {
    const claimed = ids.filter((child) => !tree.byId.has(child) || tree.parents.get(child) !== id || listedBy.has(child));

    if (claimed.length > 0) refuse(`ambiguous child relationship around ${claimed[0] ?? ''}`);
    ids.forEach((child) => listedBy.set(child, id));
  }
  for (const [id, parent] of tree.parents) {
    if (!tree.byId.has(parent) || listedBy.get(id) !== parent) refuse(`orphaned or unlisted block ${id}`);
  }
  // Iterative, so a hostile depth cannot exhaust the stack.
  tree.byId.forEach((_block, start) => walkUp(tree, start));
};

/** Climbs to the root from one block, refusing a chain that loops back. */
const walkUp = (tree: Tree, start: string): void => {
  const path: string[] = [];
  const cursor: { id: string | undefined } = { id: start };

  while (cursor.id !== undefined) {
    if (path.includes(cursor.id)) refuse(`block ${cursor.id} is its own ancestor`);
    path.push(cursor.id);
    cursor.id = tree.parents.get(cursor.id);
  }
};

const index = (blocks: Block[]): Tree => {
  const tree: Tree = { byId: new Map(), parents: new Map(), children: new Map() };

  for (const block of blocks) {
    const id = block.id;

    if (typeof id !== 'string' || id === '' || tree.byId.has(id)) refuse('every block needs a unique id');
    if (typeof block.type !== 'string' || block.type === '') refuse(`block ${String(id)} has no type`);

    const parent = readParent(block);
    const content = readContent(block);

    tree.byId.set(String(id), block);
    if (parent !== null) tree.parents.set(String(id), parent);
    if (block.content !== undefined && block.content !== null) tree.children.set(String(id), content);
  }
  crossCheck(tree);

  return tree;
};

/**
 * @param document - the host page, untouched; the plan holds copies
 * @param rowId - the `database-row` block whose body moves out
 * @param pageId - the id the body document takes
 */
export const planRowBody = (document: OutputData, rowId: string, pageId: string): RowBodyPlan => {
  const source = JSON.parse(JSON.stringify(document)) as OutputData & { blocks: Block[] };

  if (!Array.isArray(source.blocks)) refuse('the document has no blocks');
  const { byId, parents, children } = index(source.blocks);
  const row = byId.get(rowId);

  if (!row || row.type !== 'database-row') refuse('database row required');
  if (byId.get(parents.get(rowId) ?? '')?.type !== 'database') refuse('row must belong to a database');

  const data: Record<string, unknown> = row?.data ?? {};
  const bodyRoots: string[] = [];
  // Comments belong to the row where it sits, not to the body it opens.
  const retainedRoots: string[] = [];

  for (const id of children.get(rowId) ?? []) {
    (byId.get(id)?.type === 'database-comment' ? retainedRoots : bodyRoots).push(id);
  }

  const alreadyMoved = data.pageId !== undefined && data.pageId !== null;

  if (alreadyMoved && (data.pageId !== pageId || bodyRoots.length > 0)) {
    refuse('row page requires explicit reconciliation');
  }

  const moved = new Set<string>();
  const bodyBlocks: Block[] = [];
  const descendantIds: string[] = [];
  const stack = [...bodyRoots].reverse();

  while (stack.length > 0) {
    const id = String(stack.pop());
    const block = byId.get(id);

    if (block === undefined) refuse(`block ${id} vanished mid-walk`);
    moved.add(id);
    descendantIds.push(id);
    // A root of the body answers to no one now: it is a top-level block there.
    if (parents.get(id) === rowId) delete block?.parent;
    if (block) bodyBlocks.push(block);
    stack.push(...[...(children.get(id) ?? [])].reverse());
  }

  if (!alreadyMoved && row) {
    data.pageId = pageId;
    data.bodyBlocks = true;
    row.data = data;
    if (retainedRoots.length === 0) delete row.content;
    else row.content = retainedRoots;
  }
  source.blocks = source.blocks.filter((block) => !moved.has(String(block.id)));

  return { source, body: { blocks: bodyBlocks }, descendantIds, alreadyMoved };
};
