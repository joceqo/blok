/** Synchronous cell (Rust std::sync::Mutex without poisoning). */
export class Mutex<T> {
  constructor(private inner: T) {}

  lock(): Guard<T> {
    return new Guard(this);
  }
}

export class Guard<T> {
  constructor(private parent: Mutex<T>) {}

  get(): T {
    return this.parent['inner'];
  }

  set(value: T): void {
    this.parent['inner'] = value;
  }
}

export function lock<T>(mutex: Mutex<T>): Guard<T> {
  return mutex.lock();
}

interface Waiter {
  resolve: () => void;
  cancelled: boolean;
}

/**
 * tokio::sync::Notify. notifyOne stores a permit when nobody is waiting.
 * enable() before the condition check, matching notified().enable().
 */
export class Notify {
  private permits = 0;
  private waiters: Waiter[] = [];

  notifyOne(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter && !waiter.cancelled) {
        waiter.resolve();
        return;
      }
    }
    this.permits += 1;
  }

  notifyWaiters(): void {
    const all = this.waiters;
    this.waiters = [];
    for (const waiter of all) {
      if (!waiter.cancelled) {
        waiter.resolve();
      }
    }
  }

  notified(): Notified {
    return new Notified(this);
  }

  /** @internal */
  arm(waiter: Waiter): boolean {
    if (this.permits > 0) {
      this.permits -= 1;
      return true;
    }
    this.waiters.push(waiter);
    return false;
  }

  /** @internal */
  disarm(waiter: Waiter): void {
    const at = this.waiters.indexOf(waiter);
    if (at >= 0) {
      this.waiters.splice(at, 1);
    }
  }
}

export class Notified implements PromiseLike<void> {
  private waiter: Waiter = { resolve: () => {}, cancelled: false };
  private promise: Promise<void> = Promise.resolve();
  private enabled = false;

  constructor(private parent: Notify) {}

  enable(): void {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    this.promise = new Promise((resolve) => {
      this.waiter = { resolve, cancelled: false };
      if (this.parent.arm(this.waiter)) {
        resolve();
      }
    });
  }

  cancel(): void {
    this.waiter.cancelled = true;
    this.parent.disarm(this.waiter);
  }

  wait(): Promise<void> {
    if (!this.enabled) {
      this.enable();
    }
    return this.promise;
  }

  // So `await notify.notified()` parks like tokio, instead of resolving a plain object.
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.wait().then(onfulfilled, onrejected);
  }
}

/** Wait until notify, or stay pending if signal aborts (so a race can ignore it). */
export function waitNotify(notify: Notify, signal?: AbortSignal): Promise<void> {
  const notified = notify.notified();
  notified.enable();
  if (signal?.aborted) {
    notified.cancel();
    return new Promise(() => {});
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      notified.cancel();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void notified.wait().then(() => {
      signal?.removeEventListener('abort', onAbort);
      if (!signal?.aborted) {
        resolve();
      }
    });
  });
}

interface WatchWaiter {
  wake: () => void;
}

/** watch::channel — latest value broadcast. */
export function watchChannel<T>(initial: T): {
  sender: WatchSender<T>;
  receiver: WatchReceiver<T>;
} {
  let value = initial;
  let version = 0;
  const waiters = new Set<WatchWaiter>();
  const sender: WatchSender<T> = {
    sendReplace(next: T): void {
      value = next;
      version += 1;
      for (const waiter of [...waiters]) {
        waiter.wake();
      }
    },
  };
  const receiver = makeWatchReceiver(() => value, () => version, waiters);
  return { sender, receiver };
}

function makeWatchReceiver<T>(
  read: () => T,
  versionOf: () => number,
  waiters: Set<WatchWaiter>,
): WatchReceiver<T> {
  return {
    borrow(): T {
      return read();
    },
    clone(): WatchReceiver<T> {
      return makeWatchReceiver(read, versionOf, waiters);
    },
    waitFor(predicate: (value: T) => boolean, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve) => {
        const check = (): boolean => {
          if (signal?.aborted) {
            return false;
          }
          if (predicate(read())) {
            resolve();
            return true;
          }
          return false;
        };
        if (check()) {
          return;
        }
        const waiter: WatchWaiter = {
          wake(): void {
            waiters.delete(waiter);
            if (!check()) {
              waiters.add(waiter);
            }
          },
        };
        waiters.add(waiter);
        if (check()) {
          waiters.delete(waiter);
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            waiters.delete(waiter);
          },
          { once: true },
        );
      });
    },
  };
}

export interface WatchSender<T> {
  sendReplace(value: T): void;
}

export interface WatchReceiver<T> {
  borrow(): T;
  clone(): WatchReceiver<T>;
  waitFor(predicate: (value: T) => boolean, signal?: AbortSignal): Promise<void>;
}

/** tokio::sync::Mutex. Single-threaded, so the lock only serialises awaits. */
export class AsyncMutex<T> {
  private value: T;
  private locked = false;
  private queue: Array<() => void> = [];

  constructor(initial: T) {
    this.value = initial;
  }

  async lock(): Promise<AsyncGuard<T>> {
    await new Promise<void>((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
    return new AsyncGuard(this);
  }

  tryLock(): AsyncGuard<T> | undefined {
    if (this.locked) {
      return undefined;
    }
    this.locked = true;
    return new AsyncGuard(this);
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  getValue(): T {
    return this.value;
  }

  setValue(value: T): void {
    this.value = value;
  }
}

export class AsyncGuard<T> {
  private released = false;

  constructor(private parent: AsyncMutex<T>) {}

  get(): T {
    return this.parent.getValue();
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.parent.release();
  }
}

export function monotonicNow(): number {
  return performance.now();
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
      },
      { once: true },
    );
  });
}

/** Resolves when the deadline is reached. Stays pending if aborted. */
export function sleepUntil(deadline: number, signal?: AbortSignal): Promise<void> {
  return delay(deadline - monotonicNow(), signal);
}

export async function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** timeout_at: undefined means the deadline won. A deadline already past does not start the wait. */
export async function timeoutAt<T>(deadline: number, promise: Promise<T>): Promise<T | undefined> {
  const ms = deadline - monotonicNow();
  if (ms <= 0) {
    return undefined;
  }
  return withTimeout(ms, promise);
}
