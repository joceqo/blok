/** Opt-in, local diagnostics. No page text, row ids, network requests or layout reads. */
export interface PeekProfileRecord {
  id: number;
  mode: string;
  visibility: DocumentVisibilityState;
  startedAt: number;
  status: string;
  elapsedMs?: number;
  milestones: Record<string, number>;
  spans: Array<{ name: string; startMs: number; durationMs: number }>;
  longTasks: Array<{ startMs: number; durationMs: number }>;
}

const bodies = new WeakMap<HTMLElement, PeekProfile>();
let sequence = 0;
let activeProfiles = 0;

export class PeekProfile {
  public readonly record: PeekProfileRecord;
  public active = true;
  private frame: number | null = null;
  private paintTimer: number | null = null;
  private readonly deadline: number;
  private observer?: PerformanceObserver;

  constructor(mode: string) {
    activeProfiles++;
    this.record = {
      id: ++sequence, mode, visibility: document.visibilityState, startedAt: performance.now(),
      status: 'recording', milestones: {}, spans: [], longTasks: [],
    };
    const host = globalThis as { __blokPeekProfiles?: PeekProfileRecord[] };
    const history = host.__blokPeekProfiles ??= [];

    history.push(this.record);
    while (history.length > 20) {
      const removed = history.shift();

      removed?.spans.forEach(span => performance.clearMeasures?.(`blok:peek:${removed.id}:${span.name}`));
    }
    // This is a paint opportunity, not an observed paint timestamp. No layout
    // query can prove when arbitrary content reached the screen.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.paintTimer = window.setTimeout(() => {
        this.paintTimer = null;
        this.mark('shellPaintOpportunity');
      }, 0);
    });
    this.deadline = window.setTimeout(() => this.finish('window-ended'), 5000);
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      try {
        this.observer = new PerformanceObserver(list => this.collectLongTasks(list.getEntries()));
        this.observer.observe({ type: 'longtask' });
      } catch {
        this.observer?.disconnect();
        this.observer = undefined;
      }
    }
  }

  public mark(name: string): void {
    if (this.active && this.record.milestones[name] === undefined) {
      this.record.milestones[name] = performance.now() - this.record.startedAt;
    }
  }

  public measure<T>(name: string, action: () => T): T {
    if (!this.active) return action();
    const start = performance.now();

    try {
      return action();
    } finally {
      const end = performance.now();

      if (this.record.spans.length < 100) {
        this.record.spans.push({ name, startMs: start - this.record.startedAt, durationMs: end - start });
        performance.measure?.(`blok:peek:${this.record.id}:${name}`, { start, end });
      }
    }
  }

  public finish(status: 'closed' | 'superseded' | 'window-ended'): void {
    if (!this.active) return;
    this.active = false;
    activeProfiles--;
    this.record.status = status;
    this.record.elapsedMs = performance.now() - this.record.startedAt;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.paintTimer !== null) window.clearTimeout(this.paintTimer);
    window.clearTimeout(this.deadline);
    if (this.observer !== undefined) {
      this.collectLongTasks(this.observer.takeRecords());
      this.observer.disconnect();
    }
    // Printing tables must not extend the measured click or focus handler.
    window.setTimeout(() => {
      console.groupCollapsed(`[Blok peek #${this.record.id}] ${this.record.mode} · ${status}`);
      console.table(this.record.spans);
      console.table(this.record.milestones);
      console.table(this.record.longTasks);
      console.info('Durées imbriquées : ne pas les additionner. Longues tâches = thread entier. Fenêtre limitée à 5 s ; un jalon absent ne prouve pas une erreur. Export : window.__blokPeekProfiles');
      console.groupEnd();
    }, 0);
  }

  private collectLongTasks(entries: PerformanceEntry[]): void {
    for (const entry of entries) {
      if (entry.startTime + entry.duration < this.record.startedAt || this.record.longTasks.length >= 100) continue;
      this.record.longTasks.push({ startMs: entry.startTime - this.record.startedAt, durationMs: entry.duration });
    }
  }
}

export const startPeekProfile = (mode: string): PeekProfile | undefined => {
  if (typeof location === 'undefined' || new URLSearchParams(location.search).get('profile') !== '1') return undefined;

  return new PeekProfile(mode);
};

export const measurePeek = <T>(profile: PeekProfile | undefined, name: string, action: () => T): T =>
  profile === undefined ? action() : profile.measure(name, action);

export const bindPeekProfile = (holder: HTMLElement, profile: PeekProfile | undefined): void => {
  if (profile === undefined) bodies.delete(holder);
  else bodies.set(holder, profile);
};

export const peekProfileFor = (element: HTMLElement): PeekProfile | undefined => {
  if (activeProfiles === 0) return undefined;
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    const profile = bodies.get(node);

    if (profile !== undefined) return profile.active ? profile : undefined;
  }

  return undefined;
};
