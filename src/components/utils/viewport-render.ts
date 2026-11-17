/**
 * Which blocks a load may skip rendering, and which it must draw at once.
 *
 * Measured on an 870-block page: 24 of those blocks sit at the root, they
 * carry the other 846, and exactly ONE of them starts inside the first screen.
 * Mounting the other 23 is most of a multi-second freeze, and nobody is
 * looking at any of it.
 *
 * So a load draws the first few roots and puts the rest to sleep, holder and
 * all. Their tools have no DOM until something wakes them — the deferred
 * render machinery already in place (`data-blok-deferred-render`, the wake
 * event on the holder, `shouldDeferRender` re-asked on waking). This module
 * only decides WHO sleeps; it does not render anything itself.
 */

/** How many roots are still owed an eager mount in this pass; null outside one. */
let eagerLeft: number | null = null;

/** Who is asleep, in the order they fell asleep — which is document order. */
const asleep = new Set<string>();

/**
 * Opens a load pass: the next `eager` root blocks render at once, the rest
 * sleep.
 * @param eager - how many root blocks to draw immediately
 */
export const beginViewportPass = (eager: number): void => {
  eagerLeft = eager;
};

/** Closes the pass. Outside a pass nothing sleeps. */
export const endViewportPass = (): void => {
  eagerLeft = null;
};

/**
 * Asks whether this root block is one of the first — and spends the budget.
 *
 * Outside a load pass the answer is always yes: a block inserted by hand, or
 * pasted, must appear where the person put it.
 * @returns whether this root must render now
 */
export const claimEagerRoot = (): boolean => {
  if (eagerLeft === null) {
    return true;
  }
  if (eagerLeft <= 0) {
    return false;
  }
  eagerLeft -= 1;

  return true;
};

/** Remembers that this block's tool has no DOM yet. */
export const sleepBlock = (id: string): void => {
  asleep.add(id);
};

/** Whether this block is still waiting to be drawn. */
export const isAsleep = (id: string): boolean => asleep.has(id);

/** Forgets a block, so `shouldDeferRender` stops holding it back. */
export const wakeBlock = (id: string): void => {
  asleep.delete(id);
};

/** The sleepers, in document order. */
export const sleepingBlocks = (): Iterable<string> => [...asleep];

/** Drops every pass and sleeper. For tests and for tearing an editor down. */
export const resetViewportRender = (): void => {
  eagerLeft = null;
  asleep.clear();
};
