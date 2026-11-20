const POOL_SIZE = 4;
const PER_CALLER = 2;

class Semaphore {
  private slots: number;
  private readonly queue: Array<(release: () => void) => void> = [];

  constructor(capacity: number) {
    this.slots = capacity;
  }

  async acquire(deadlineMs: number): Promise<() => void> {
    if (this.slots > 0) {
      this.slots -= 1;
      return () => this.signal();
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
      const wake = (release: () => void): void => {
        clearTimeout(timer);
        resolve(release);
      };
      this.queue.push(wake);
    });
  }

  private signal(): void {
    const next = this.queue.shift();
    if (next) {
      next(() => this.signal());
    } else {
      this.slots += 1;
    }
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
    const releasePool = await pool.acquire(deadlineMs);
    return () => {
      releasePool();
      leaveCaller();
    };
  }
}