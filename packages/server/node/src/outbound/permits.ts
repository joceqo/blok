const POOL_SIZE = 4;
const PER_CALLER = 2;

class Semaphore {
  private inUse = 0;
  private readonly queue: Array<{ resolve: (release: () => void) => void; reject: (e: Error) => void }> = [];

  constructor(readonly capacity: number) {}

  tryAcquire(): (() => void) | undefined {
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      return () => {
        this.inUse -= 1;
        const next = this.queue.shift();
        if (next) {
          this.inUse += 1;
          next.resolve(() => {
            this.inUse -= 1;
            const n = this.queue.shift();
            if (n) {
              this.inUse += 1;
              n.resolve(() => this.releaseOne());
            }
          });
        }
      };
    }
    return undefined;
  }

  private releaseOne(): void {
    this.inUse -= 1;
    const next = this.queue.shift();
    if (next) {
      this.inUse += 1;
      next.resolve(() => this.releaseOne());
    }
  }

  acquire(deadlineMs: number): Promise<() => void> {
    const direct = this.tryAcquire();
    if (direct) {
      return Promise.resolve(direct);
    }
    return new Promise((resolve, reject) => {
      const wait = Date.now() + Math.max(0, deadlineMs - Date.now());
      const timer = setTimeout(() => reject(new Error('timed out')), wait);
      this.queue.push({
        resolve: (release) => {
          clearTimeout(timer);
          resolve(release);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }
}

class CallerLanes {
  private readonly lanes = new Map<string, { sem: Semaphore; users: number }>();

  async enter(caller: string, deadlineMs: number): Promise<() => void> {
    if (caller === '') {
      return () => {};
    }
    let lane = this.lanes.get(caller);
    if (!lane) {
      lane = { sem: new Semaphore(PER_CALLER), users: 0 };
      this.lanes.set(caller, lane);
    }
    lane.users += 1;
    const releaseSlot = await lane.sem.acquire(deadlineMs);
    return () => {
      releaseSlot();
      lane!.users -= 1;
      if (lane!.users === 0) {
        this.lanes.delete(caller);
      }
    };
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
    const releasePool = await pool.acquire(deadlineMs);
    return () => {
      releasePool();
      leaveCaller();
    };
  }
}