import type { OutboundWait } from '../collab/observe.ts';
import { Mutex, lock } from '../http/sync.ts';

export const POOL_SIZE = 4;
const PER_CALLER = 2;

/**
 * A slot, and whether its holder had to queue for it. Only the semaphore can
 * tell the two apart: by the time the caller is awake, a slot it waited on and
 * a slot that was free look exactly the same.
 */
interface Permit {
  release: () => void;
  queued: boolean;
}

class Semaphore {
  private slots: number;
  private readonly queue: Array<(release: () => void) => void> = [];
  private readonly mutex = new Mutex(undefined);

  constructor(capacity: number) {
    this.slots = capacity;
  }

  async acquire(deadlineMs: number): Promise<Permit> {
    const permit = await new Promise<Permit>((resolve, reject) => {
      const tryAcquire = (): void => {
        const guard = lock(this.mutex);
        if (this.slots > 0) {
          this.slots -= 1;
          guard.get();
          resolve({ release: () => this.signal(), queued: false });
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
          resolve({ release: releaseSlot, queued: true });
        };
        this.queue.push(wakeFn);
      };
      tryAcquire();
    });
    return permit;
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

  async enter(caller: string, deadlineMs: number): Promise<Permit> {
    if (caller === '') {
      return { release: () => {}, queued: false };
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

  /**
   * Told of a caller that had to queue, once the wait is over, so the line it
   * writes can say how long it lasted. Nothing is reported for an acquire that
   * found a free slot: four pools times every outbound call is not an event.
   */
  onWait?: (event: OutboundWait) => void;

  async acquire(upload: boolean, caller: string, deadlineMs: number): Promise<() => void> {
    const callers = upload ? this.uploadCallers : this.checkCallers;
    const pool = upload ? this.uploads : this.checks;
    const started = Date.now();
    let lane: Permit;
    try {
      lane = await callers.enter(caller, deadlineMs);
    } catch (error) {
      // Only a wait can time out, so the deadline passing IS the report.
      this.report(upload, caller, started, false);
      throw error;
    }
    try {
      const slot = await pool.acquire(deadlineMs);
      if (lane.queued || slot.queued) {
        this.report(upload, caller, started, true);
      }
      let done = false;
      return () => {
        if (done) {
          return;
        }
        done = true;
        slot.release();
        lane.release();
      };
    } catch (error) {
      lane.release();
      this.report(upload, caller, started, false);
      throw error;
    }
  }

  private report(upload: boolean, caller: string, started: number, granted: boolean): void {
    this.onWait?.({ upload, caller, waitedMs: Date.now() - started, granted });
  }
}

/** One pool per process, as in C# DI singleton and Go/Rust shared Fetcher slots. */
export const sharedOutboundPermits = new OutboundPermits();