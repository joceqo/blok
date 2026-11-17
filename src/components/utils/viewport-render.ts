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

/**
 * Marks a holder standing in for a block nobody has scrolled to.
 *
 * A placeholder is nearly flat, so without a reserved height the whole page
 * would collapse into one screen and every sleeper would read as visible at
 * once — the stylesheet gives this attribute a height to stand on.
 */
export const OFFSCREEN_ATTRIBUTE = 'data-blok-offscreen';

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

/**
 * How far beyond the screen a sleeper is woken.
 *
 * Generous on purpose: waking costs real work, so it must start well before
 * the block is needed, or the person scrolls into a blank space and waits.
 */
const WAKE_MARGIN_PX = 1200;

/**
 * Wakes each sleeper when it comes near the screen, and not before.
 *
 * This is what makes the saving real rather than merely deferred: a first
 * version woke every sleeper in a loop straight after the mount, which moved
 * the work without removing any of it — the load measured exactly the same
 * 9 s. A block nobody scrolls to is never drawn at all.
 *
 * Without IntersectionObserver every sleeper is woken at once: a browser that
 * cannot tell us what is visible must not be left with invisible content.
 * @param sleepers - the blocks to watch, with the holders that stand in for them
 * @param wake - what to run when one of them comes into view
 */
export const observeSleepers = (
  sleepers: Array<{ id: string; holder: HTMLElement }>,
  wake: (id: string) => void
): void => {
  const Observer = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;

  if (typeof Observer !== 'function') {
    for (const sleeper of sleepers) {
      wakeBlock(sleeper.id);
      wake(sleeper.id);
    }

    return;
  }

  const byHolder = new Map<Element, string>(sleepers.map(sleeper => [sleeper.holder, sleeper.id]));
  const observer = new Observer((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }

      const id = byHolder.get(entry.target);

      if (id === undefined) {
        continue;
      }

      // Unobserved and forgotten before waking: the render changes the
      // holder's size, which would otherwise report it as intersecting again.
      byHolder.delete(entry.target);
      observer.unobserve(entry.target);
      wakeBlock(id);
      wake(id);
    }
  }, { rootMargin: `${WAKE_MARGIN_PX}px 0px ${WAKE_MARGIN_PX}px 0px` });

  for (const sleeper of sleepers) {
    observer.observe(sleeper.holder);
  }
};
