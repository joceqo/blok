import { AsyncMutex } from '../http/sync.ts';

export const POOL_SIZE = 4;
const PER_CALLER = 2;

class Semaphore {
  private permits: number;
  private readonly waiting: Array<() => void> = [];
  private readonly gate = new AsyncMutex(undefined);

  constructor(capacity: number) {
    this.permits = capacity;
  }

  private releaseCallback(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      void this.release();
    };
  }

  private async release(): Promise<void> {
    const guard = await this.gate.lock();
    const wake = this.waiting.shift();
    if (wake) {
      guard.release();
      wake();
      return;
    }
    this.permits += 1;
    guard.release();
  }

  async acquire(deadlineMs: number): Promise<() => void> {
    const guard = await this.gate.lock();
    if (this.permits > 0) {
      this.permits -= 1;
      guard.release();
      return this.releaseCallback();
    }
    guard.release();
    await new Promise<void>((resolve, reject) => {
      const delay = Math.max(0, deadlineMs - Date.now());
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(wake);
        if (index >= 0) {
          this.waiting.splice(index, 1);
        }
        reject(new Error('timed out'));
      }, delay);
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiting.push(wake);
    });
    return this.releaseCallback();
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