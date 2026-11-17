/**
 * HTML manipulation utilities
 */

/**
 * Strips editor-only wrapper elements from HTML content: the inline toolbar's
 * fake selection background and the slash menu's pill around "/query". The
 * block stays watched while the slash menu is open, so its saves see the pill.
 * @param html - HTML content that may contain those wrappers
 * @returns HTML content with the wrappers removed but their content preserved
 */
export const stripFakeBackgroundElements = (html: string): string => {
  if (!html || (!html.includes('data-blok-fake-background') && !html.includes('data-blok-slash-search'))) {
    return html;
  }

  const tempDiv = document.createElement('div');

  tempDiv.innerHTML = html;

  const fakeBackgrounds = tempDiv.querySelectorAll('[data-blok-fake-background="true"], span[data-blok-slash-search]');

  fakeBackgrounds.forEach((element) => {
    const parent = element.parentNode;

    if (!parent) {
      return;
    }

    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element);
    }

    parent.removeChild(element);
  });

  return tempDiv.innerHTML;
};

/**
 * An intersection rather than `interface extends Element`: TypeScript 6's
 * lib.dom.d.ts declares `moveBefore` as a required member of ParentNode, and an
 * interface may not redeclare an inherited member as optional. Intersections
 * skip that declaration-compatibility check, so this compiles on both the 5.9
 * libs (no `moveBefore` at all) and the 6.0 libs (required `moveBefore`).
 */
type StatefulMoveParent = Element & {
  moveBefore?(node: Node, reference: Node | null): void;
};

/**
 * Repositions an already-attached node within `parent`, inserting it before
 * `reference` (or at the end when `reference` is null), while preserving the
 * node's live state — an iframe keeps its loaded document, media keeps playing,
 * form fields keep focus and value.
 *
 * A plain insertBefore/appendChild detaches and re-attaches the node, which
 * resets exactly that state (re-parented iframes reload). The browser's
 * state-preserving move (`moveBefore`, Chrome 133+) avoids the detach; we fall
 * back to insertBefore where it is unavailable or throws (e.g. cross-document
 * moves, or a node that is not connected).
 */
const statefulMove = (parent: StatefulMoveParent, node: Node, reference: Node | null): void => {
  if (reference === node) {
    return;
  }

  // Neither move keeps a caret inside the node: insertBefore detaches it, and
  // Chrome's moveBefore moves the caret too (a move redo lost U113's caret).
  const keep = selectionInside(node);

  moveNode(parent, node, reference);

  if (keep !== null) {
    window.getSelection()?.setBaseAndExtent(keep.anchorNode, keep.anchorOffset, keep.focusNode, keep.focusOffset);
  }
};

const moveNode = (parent: StatefulMoveParent, node: Node, reference: Node | null): void => {
  if (typeof parent.moveBefore === 'function' && node.isConnected && parent.isConnected) {
    try {
      parent.moveBefore(node, reference);

      return;
    } catch {
      // moveBefore enforces stricter invariants than insertBefore (same
      // document, connected node); fall back to a plain, state-resetting insert.
    }
  }

  parent.insertBefore(node, reference);
};

/**
 * The live selection when both its ends sit inside `node`, else null.
 * @param node - the node about to move
 */
/**
 * Counts which exit of `selectionInside` a move takes, when something is
 * counting. Installed by the boot profiler (`?profile=1`) and absent in a
 * normal session, where this costs one property read per move.
 *
 * The profile blames this function for 26.8 s of a 46 s load but cannot say
 * which exit runs: the loading redactor is meant to be inert, which would skip
 * the costly read entirely. Guessing wrong here means optimising the wrong line.
 * @param exit - which way the function returned
 */
const countSelectionExit = (exit: 'detached' | 'inert' | 'read' | 'batched'): void => {
  const probe = (globalThis as { __blokSelectionProbe?: Record<string, number> }).__blokSelectionProbe;

  if (probe === undefined) {
    return;
  }

  probe[exit] = (probe[exit] ?? 0) + 1;

  // A sampling profile names selectionInside but not who called it, and the
  // first fix aimed at the wrong caller: the counts did not move at all.
  // Record where the costly exit is reached from, the first time each.
  const callers = (globalThis as { __blokSelectionCallers?: Record<string, number> }).__blokSelectionCallers;

  if (exit === 'read' && callers !== undefined) {
    const stack = new Error().stack ?? '';
    const key = stack.split('\n').slice(2, 11).map(line => line.trim()).join(' <- ').slice(0, 700);

    callers[key] = (callers[key] ?? 0) + 1;
  }
};

/** What a move needs to know about the caret, as plain values. */
interface SelectionAnchor {
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}

/**
 * The anchor remembered for the current batch of moves.
 *
 * `undefined` outside a batch, `null` for a batch that started with no
 * selection, an anchor otherwise.
 */
let batchedAnchor: SelectionAnchor | null | undefined;

/** Whether a batch is open but has not needed the selection yet. */
let batchPending = false;

/**
 * The batch's anchor, read from the live selection on first need only.
 *
 * Reading it when the batch OPENS would read on every mount, including the
 * mounts that move nothing — and merely touching the selection has side effects
 * a render must not have.
 */
const batchAnchor = (): SelectionAnchor | null => {
  if (!batchPending) {
    return batchedAnchor ?? null;
  }
  batchPending = false;

  const selection = typeof window === 'undefined' ? null : window.getSelection();
  const anchorNode = selection?.anchorNode ?? null;
  const focusNode = selection?.focusNode ?? null;

  batchedAnchor =
    selection === null || selection.rangeCount === 0 || anchorNode === null || focusNode === null
      ? null
      : { anchorNode, anchorOffset: selection.anchorOffset, focusNode, focusOffset: selection.focusOffset };

  return batchedAnchor;
};

/**
 * Runs a batch of moves against ONE reading of the selection.
 *
 * Mounting a document moves a holder per nested child, and each move read the
 * live selection right after a DOM write — a layout-dependent read on a dirty
 * layout, which makes Chrome recompute the whole page. Measured on a 849-block
 * load: 862 such reads at ~31 ms each, 26.7 s of a 46 s freeze.
 *
 * Reading once is enough because what each move actually asks is whether the
 * caret sits inside the node it is about to move, and `node.contains` answers
 * that from a remembered anchor for free. The anchor stays valid across the
 * batch: the only thing that moves the caret here is the restore each move
 * performs, which puts it back on those very nodes and offsets.
 *
 * A cache keyed on `selectionchange` was tried and rejected: Chrome does not
 * emit that event within the task that changed the selection, so a caret
 * restored just before a move would be missed (the U113 scenario).
 * @param run - the moves to perform
 * @returns whatever `run` returned
 */
export const withBatchedMoves = <T>(run: () => T): T => {
  // A nested batch keeps the outer anchor: it was read before any of these moves.
  if (batchedAnchor !== undefined) {
    return run();
  }

  batchedAnchor = null;
  batchPending = true;

  try {
    return run();
  } finally {
    batchedAnchor = undefined;
    batchPending = false;
  }
};

const selectionInside = (node: Node): { anchorNode: Node; anchorOffset: number; focusNode: Node; focusOffset: number } | null => {
  // A detached node cannot hold the selection. Checked first because Chrome
  // forces a whole-page layout on each selection read while nothing is selected.
  // The loading redactor is inert: it cannot carry a user caret either.
  if (!node.isConnected) {
    countSelectionExit('detached');

    return null;
  }

  if (node instanceof Element && node.closest('[inert]') !== null) {
    countSelectionExit('inert');

    return null;
  }

  if (batchedAnchor !== undefined) {
    countSelectionExit('batched');

    const anchor = batchAnchor();

    return anchor !== null && node.contains(anchor.anchorNode) && node.contains(anchor.focusNode)
      ? anchor
      : null;
  }

  countSelectionExit('read');

  const selection = typeof window === 'undefined' ? null : window.getSelection();
  const anchorNode = selection?.anchorNode ?? null;
  const focusNode = selection?.focusNode ?? null;

  if (selection === null || selection.rangeCount === 0 || anchorNode === null || focusNode === null || !node.contains(anchorNode) || !node.contains(focusNode)) {
    return null;
  }

  return { anchorNode, anchorOffset: selection.anchorOffset, focusNode, focusOffset: selection.focusOffset };
};

/**
 * Moves `node` to sit immediately before `reference`, preserving live state.
 * @see statefulMove
 */
export const moveElementBefore = (node: Node, reference: Element): void => {
  const parent = reference.parentNode;

  if (parent instanceof Element) {
    statefulMove(parent, node, reference);
  }
};

/**
 * Moves `node` to sit immediately after `reference`, preserving live state.
 * @see statefulMove
 */
export const moveElementAfter = (node: Node, reference: Element): void => {
  const parent = reference.parentNode;

  if (parent instanceof Element) {
    statefulMove(parent, node, reference.nextSibling);
  }
};

/**
 * Moves `node` to the end of `parent`'s children, preserving live state.
 * @see statefulMove
 */
export const moveElementToEnd = (parent: Element, node: Node): void => {
  statefulMove(parent, node, null);
};
