import { Mutex, lock } from '../http/sync.ts';

export const POOL_SIZE = 4;
const PER_CALLER = 2;

class Semaphore {
  private slots: number;
  private readonly queue: Array<(release: () => void) => void> = [];
  private readonly mutex = new Mutex(undefined);

  constructor(capacity: number) {
    this.slots = capacity;
  }

  async acquire(deadlineMs: number): Promise<() => void> {
    const release = await new Promise<() => void>((resolve, reject) => {
      const tryAcquire = (): void => {
        const guard = lock(this.mutex);
        if (this.slots > 0) {
          this.slots -= 1;
          guard.get();
          resolve(() => this.signal());
          return;
        }
        guard.get();
        const delay = Math.max(0, deadlineMs - Date.now());
        const timer = setTimeout(() => {
          const g = lock(this.mutex);
          const index = this.queue.findIndex((wake) => wake === wakeFn);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          g.get();
          reject(new Error('timed out'));
        }, delay);
        const wakeFn = (releaseSlot: () => void): void => {
          clearTimeout(timer);
          resolve(releaseSlot);
        };
        this.queue.push(wakeFn);
      };
      tryAcquire();
    });
    return release;
  }

  private signal(): void {
    const guard = lock(this.mutex);
    const next = this.queue.shift();
    if (next) {
      guard.get();
      next(() => this.signal());
      return;
    }
    this.slots += 1;
    guard.get();
  }
}

class CallerLanes {
  private readonly lanes = new Map<string, Semaphore>();

  async enter(caller: string, deadlineMs: number): Promise<() => void> {
    if (caller === '') {
      return () => {};
    }
    let lane = this.lanes.get(caller);
    if (!lane) {
      lane = new Semaphore(PER_CALLER);
      this.lanes.set(caller, lane);
    }
    return lane.acquire(deadlineMs);
  }
}

export class OutboundPermits {
  private readonly checks = new Semaphore(POOL_SIZE);
  private readonly uploads = new Semaphore(POOL_SIZE);
  private readonly checkCallers = new CallerLanes();
  private readonly uploadCallers = new CallerLanes();

  async acquire(upload: boolean, caller: string, deadlineMs: number): Promise<() => void> {
    const callers = upload ? this.uploadCallers : this.checkCallers;
    const pool = upload ? this.uploads : this.checks;
    const leaveCaller = await callers.enter(caller, deadlineMs);
    try {
      const releasePool = await pool.acquire(deadlineMs);
      let done = false;
      return () => {
        if (done) {
          return;
        }
        done = true;
        releasePool();
        leaveCaller();
      };
    } catch (error) {
      leaveCaller();
      throw error;
    }
  }
}

/** One pool per process, as in C# DI singleton and Go/Rust shared Fetcher slots. */
export const sharedOutboundPermits = new OutboundPermits();