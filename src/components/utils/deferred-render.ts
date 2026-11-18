/** Internal DOM handshake: holders stay in the block tree while their tools sleep. */
export const DEFERRED_RENDER_EVENT = 'blok:render-deferred';

interface RenderQueue { enqueue(holder: HTMLElement): void; cancel(): void }
const queues = new WeakMap<HTMLElement, RenderQueue>();
const deferredSelector = '[data-blok-deferred-render]';

/** Opening a row wakes its body, but each block still checks nested closed rows. */
export function renderDeferredDescendants(holder: HTMLElement): void {
  for (let parent: HTMLElement | null = holder; parent !== null; parent = parent.parentElement) {
    const queue = queues.get(parent);

    if (queue !== undefined) {
      queue.enqueue(holder);
      return;
    }
  }
  holder.querySelectorAll<HTMLElement>(deferredSelector).forEach((child) => {
    // A parent's rendered hook may already have woken this child.
    if (child.matches(deferredSelector)) child.dispatchEvent(new Event(DEFERRED_RENDER_EVENT));
  });
}

/**
 * Wake an opened row in document order, yielding after 8 ms or 24 tools.
 * Recursive rendered hooks join the same queue instead of consuming the rest
 * of the body in one task. A single tool is atomic and can exceed the budget.
 * Keep the queue registered until detach, so async tools use it too.
 */
export function scheduleDeferredDescendants(root: HTMLElement, options: {
  isCurrent(): boolean;
  onBatch?(render: () => void): void;
  onIdle?(): void;
}): () => void {
  queues.get(root)?.cancel();
  const pending = new Set<HTMLElement>();
  let frame: number | null = null;
  let timer: number | null = null;
  let running = false;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) window.clearTimeout(timer);
    pending.clear();
    // Leave a cancelled registration until the next opening replaces it.
    // A late async tool must not fall back to a synchronous subtree wake while
    // the just-closed row is still visible in its exit animation.
  };
  const schedule = (): void => {
    if (running || cancelled || frame !== null || timer !== null || pending.size === 0) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      timer = window.setTimeout(() => { timer = null; run(); }, 0);
    });
  };
  const run = (): void => {
    if (cancelled) return;
    if (!root.isConnected || !options.isCurrent()) { cancel(); return; }
    running = true;
    const render = (): void => {
      const start = performance.now();
      let count = 0;

      for (const child of pending) {
        pending.delete(child);
        if (root.contains(child) && child.matches(deferredSelector)) {
          child.dispatchEvent(new Event(DEFERRED_RENDER_EVENT));
        }
        if (++count >= 24 || performance.now() - start >= 8) break;
      }
    };

    try {
      if (options.onBatch === undefined) render();
      else options.onBatch(render);
    } finally {
      running = false;
      if (!cancelled && pending.size === 0) options.onIdle?.();
      else schedule();
    }
  };
  const queue: RenderQueue = {
    cancel,
    enqueue(holder) {
      if (cancelled) return;
      holder.querySelectorAll<HTMLElement>(deferredSelector).forEach(child => pending.add(child));
      schedule();
    },
  };

  queues.set(root, queue);
  // The caller has already yielded for the shell. Show the first small batch now.
  running = true;
  queue.enqueue(root);
  run();
  return cancel;
}
