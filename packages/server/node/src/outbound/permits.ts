export const POOL_SIZE = 4;
const PER_CALLER = 2;

class ConcurrencyPool {
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(deadlineMs: number): Promise<() => void> {
    if (this.inFlight < this.capacity) {
      this.inFlight += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        this.inFlight -= 1;
        const wake = this.queue.shift();
        if (wake) {
          this.inFlight += 1;
          wake();
        }
      };
    }
    return new Promise((resolve, reject) => {
      const delay = Math.max(0, deadlineMs - Date.now());
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(wake);
        if (index >= 0) {
          this.queue.splice(index, 1);
        }
        reject(new Error('timed out'));
      }, delay);
      const wake = (): void => {
        clearTimeout(timer);
        let released = false;
        resolve(() => {
          if (released) {
            return;
          }
          released = true;
          this.inFlight -= 1;
          const next = this.queue.shift();
          if (next) {
            this.inFlight += 1;
            next();
          }
        });
      };
      this.queue.push(wake);
    });
  }
}

class CallerLanes {
  private readonly lanes = new Map<string, ConcurrencyPool>();

  async enter(caller: string, deadlineMs: number): Promise<() => void> {
    if (caller === '') {
      return () => {};
    }
    let lane = this.lanes.get(caller);
    if (!lane) {
      lane = new ConcurrencyPool(PER_CALLER);
      this.lanes.set(caller, lane);
    }
    return lane.acquire(deadlineMs);
  }
}

export class OutboundPermits {
  private readonly checks = new ConcurrencyPool(POOL_SIZE);
  private readonly uploads = new ConcurrencyPool(POOL_SIZE);
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