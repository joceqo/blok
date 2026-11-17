/**
 * Sampling profile of the boot, for the one question screenshots cannot answer:
 * which function holds the main thread while the page is frozen.
 *
 * Chrome exposes `Profiler` only when the document is served with
 * `Document-Policy: js-profiling` (see `deploy/Caddyfile`). Opt in per load
 * with `?profile=1`; nothing is sampled otherwise.
 */

/** One function in a sampled stack. */
interface ProfilerFrame {
  name: string;
  resourceId?: number;
  line?: number;
  column?: number;
}

/** A stack, as a frame plus the stack it was called from. */
interface ProfilerStack {
  frameId: number;
  parentId?: number;
}

/** One sample: where the thread was at a point in time. */
interface ProfilerSample {
  timestamp: number;
  stackId?: number;
}

/** What `Profiler.stop()` resolves to. */
export interface ProfilerTrace {
  resources: string[];
  frames: ProfilerFrame[];
  stacks: ProfilerStack[];
  samples: ProfilerSample[];
}

/** One function's share of the profile. */
export interface ProfileRow {
  name: string;
  /** Where the function is defined, which tells homonyms apart. */
  location: string;
  /** Milliseconds sampled with this function at the top of the stack. */
  selfMs: number;
  /** Milliseconds sampled anywhere beneath it, counted once per sample. */
  totalMs: number;
  /** Share of the profile spent in this function itself. */
  selfPct: number;
}

/** What `summarizeProfile` reports. */
export interface ProfileSummary {
  durationMs: number;
  sampleCount: number;
  top: ProfileRow[];
  /** How each exit of selectionInside was reached, when the probe was installed. */
  selectionExits?: Record<string, number>;
}

const ANONYMOUS = '(anonyme)';
const NO_SOURCE = '(sans source)';

/**
 * Where a frame is defined, as `file:line:column`.
 *
 * Rolldown mangles every top-level function to one or two letters, per chunk:
 * a dozen unrelated functions are all called `Ce`. Keyed on the name alone,
 * their times are summed and the profile points at a function that does not
 * exist. The definition site is what makes a row mean one function.
 * @param trace - the trace the frame belongs to
 * @param frame - the frame to place
 */
const locationOf = (trace: ProfilerTrace, frame: ProfilerFrame): string => {
  const resource = frame.resourceId === undefined ? undefined : trace.resources[frame.resourceId];

  if (resource === undefined) {
    return NO_SOURCE;
  }

  const file = resource.replace(/^https?:\/\/[^/]+/, '');

  return `${file}:${frame.line ?? 0}:${frame.column ?? 0}`;
};

/**
 * How long a sample stands for: the gap since the previous one. The first
 * sample has no predecessor, so it borrows the median gap of the others.
 * @param samples - samples in the order the profiler took them
 */
const weighSamples = (samples: readonly ProfilerSample[]): number[] => {
  const gaps = samples.slice(1).map((sample, index) => sample.timestamp - samples[index].timestamp);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 1;

  return samples.map((_, index) => (index === 0 ? median : gaps[index - 1]));
};

/**
 * Walks a stack from its top frame down to the root.
 * @param trace - the profiler trace the stack belongs to
 * @param stackId - the stack to walk
 */
const framesOf = (trace: ProfilerTrace, stackId: number): { name: string; location: string }[] => {
  const frames: { name: string; location: string }[] = [];
  let cursor: number | undefined = stackId;

  while (cursor !== undefined) {
    const stack: ProfilerStack | undefined = trace.stacks[cursor];
    if (stack === undefined) {
      break;
    }
    const frame = trace.frames[stack.frameId];
    frames.push({
      name: frame?.name || ANONYMOUS,
      location: frame === undefined ? NO_SOURCE : locationOf(trace, frame),
    });
    cursor = stack.parentId;
  }

  return frames;
};

/**
 * Turns a raw trace into a ranked list of functions, heaviest self time first.
 *
 * A sample with no stack is thread time with no JavaScript on it: it counts
 * towards the duration and is charged to nobody.
 * @param trace - the trace `Profiler.stop()` resolved to
 * @param options - `limit` caps how many functions are reported
 */
export function summarizeProfile(trace: ProfilerTrace, options: { limit?: number } = {}): ProfileSummary {
  const weights = weighSamples(trace.samples);
  const rows = new Map<string, { name: string; location: string; selfMs: number; totalMs: number }>();
  const rowFor = (frame: { name: string; location: string }): { selfMs: number; totalMs: number } => {
    const key = `${frame.name}@${frame.location}`;
    const existing = rows.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = { name: frame.name, location: frame.location, selfMs: 0, totalMs: 0 };
    rows.set(key, created);

    return created;
  };

  let durationMs = 0;

  trace.samples.forEach((sample, index) => {
    const weight = weights[index];
    durationMs += weight;

    if (sample.stackId === undefined) {
      return;
    }

    const frames = framesOf(trace, sample.stackId);
    if (frames.length === 0) {
      return;
    }

    rowFor(frames[0]).selfMs += weight;
    // A recursive frame appears at several levels of one stack; it waited once.
    const seen = new Set<string>();
    frames.forEach(frame => {
      const key = `${frame.name}@${frame.location}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      rowFor(frame).totalMs += weight;
    });
  });

  const top = [...rows.values()]
    .map(totals => ({
      name: totals.name,
      location: totals.location,
      selfMs: Math.round(totals.selfMs),
      totalMs: Math.round(totals.totalMs),
      selfPct: durationMs > 0 ? Math.round((totals.selfMs / durationMs) * 100) : 0,
    }))
    .sort((a, b) => b.selfMs - a.selfMs || b.totalMs - a.totalMs)
    .slice(0, options.limit ?? 30);

  return { durationMs: Math.round(durationMs), sampleCount: trace.samples.length, top };
}

interface RunningProfiler {
  stop(): Promise<ProfilerTrace>;
}

interface ProfilerConstructor {
  new (options: { sampleInterval: number; maxBufferSize: number }): RunningProfiler;
}

/** The profiler started for this load, if any. */
let running: RunningProfiler | null = null;

/** Cleans up the watcher that decides when sampling has seen enough. */
let stopWatching: (() => void) | null = null;

/** How long the thread must stay quiet before the profile is considered done. */
const QUIET_MS = 3_000;

/** Upper bound on a profile, so a page that never settles still reports. */
const MAX_MS = 120_000;

/**
 * Whether sampling has seen the whole freeze and can stop.
 *
 * Stopping at the first idle does NOT work: the boot yields once before the
 * freeze begins, and a profile taken there is 300 ms of nothing. So wait for
 * the thread to have worked, then to have fallen quiet.
 * @param state - when sampling began, when the thread was last busy, and now
 * @param options - the quiet window and the safety net
 */
export function shouldStopProfile(
  state: { startedAt: number; lastBusyAt: number | null; now: number },
  options: { quietMs?: number; maxMs?: number } = {}
): boolean {
  const { quietMs = QUIET_MS, maxMs = MAX_MS } = options;

  if (state.now - state.startedAt >= maxMs) {
    return true;
  }

  if (state.lastBusyAt === null) {
    return false;
  }

  return state.now - state.lastBusyAt >= quietMs;
}

/**
 * Whether this load asked to be profiled, through `?profile=1`.
 */
const profileRequested = (): boolean => new URLSearchParams(location.search).get('profile') === '1';

/**
 * Watches the main thread and stops the profile once the freeze is over.
 *
 * Long tasks are the signal: during a 40 s freeze nothing else runs, and the
 * observer delivers the entry as soon as the thread is handed back.
 */
const watchUntilQuiet = (): void => {
  const startedAt = performance.now();
  let lastBusyAt: number | null = null;

  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      lastBusyAt = Math.max(lastBusyAt ?? 0, entry.startTime + entry.duration);
    }
  });
  observer.observe({ type: 'longtask', buffered: true });

  const timer = setInterval(() => {
    if (!shouldStopProfile({ startedAt, lastBusyAt, now: performance.now() })) {
      return;
    }
    void stopBootProfile();
  }, 500);

  stopWatching = () => {
    clearInterval(timer);
    observer.disconnect();
  };
};

/**
 * Starts sampling, if this load asked for it and the browser allows it.
 *
 * Call it as early as the entry module runs: the freeze being chased starts
 * before anything is painted. Sampling stops on its own, once the thread has
 * worked and then fallen quiet.
 */
export function startBootProfile(): void {
  if (running !== null || !profileRequested()) {
    return;
  }

  const Ctor = (globalThis as { Profiler?: ProfilerConstructor }).Profiler;
  if (Ctor === undefined) {
    console.warn('[blok] profil impossible : Profiler absent de ce navigateur.');

    return;
  }

  try {
    // 10 ms is Chrome's floor in practice; a 45 s freeze needs the big buffer.
    running = new Ctor({ sampleInterval: 10, maxBufferSize: 1_000_000 });
    // Read by selectionInside (src/components/utils/html.ts). A sampling profile
    // names the function but not which of its three exits ran; these do.
    (globalThis as { __blokSelectionProbe?: Record<string, number> }).__blokSelectionProbe = {
      detached: 0,
      inert: 0,
      read: 0,
    };
    (globalThis as { __blokSelectionCallers?: Record<string, number> }).__blokSelectionCallers = {};
    (globalThis as { __blokDatabaseProbe?: { count: number; stacks: Record<string, number> } }).__blokDatabaseProbe = { count: 0, stacks: {} };
    (globalThis as { __blokRenderProbe?: Record<string, unknown> }).__blokRenderProbe = {};
    (globalThis as { __blokLoaderProbe?: Record<string, unknown> }).__blokLoaderProbe = {};
    (globalThis as { __blokBatchProbe?: Record<string, unknown> }).__blokBatchProbe = {};
    console.info('[blok] profil du démarrage en cours…');
    watchUntilQuiet();
  } catch (error) {
    // The one failure worth naming: the header is missing, not the API.
    console.warn('[blok] profil refusé — ajoutez « Document-Policy: js-profiling ».', error);
  }
}

/**
 * Stops sampling and prints what held the thread.
 *
 * The summary is also left on `window.__blokBootProfile` so it can be copied
 * out of a console whose rows have already scrolled away.
 * @param label - what was being measured, for the console group
 */
export async function stopBootProfile(label = 'démarrage'): Promise<ProfileSummary | null> {
  const profiler = running;
  if (profiler === null) {
    return null;
  }
  running = null;
  stopWatching?.();
  stopWatching = null;

  const trace = await profiler.stop();
  const selectionExits = (globalThis as { __blokSelectionProbe?: Record<string, number> }).__blokSelectionProbe;
  const callers = (globalThis as { __blokSelectionCallers?: Record<string, number> }).__blokSelectionCallers;
  const summary = { ...summarizeProfile(trace), ...(selectionExits !== undefined && { selectionExits }) };

  (globalThis as { __blokBootProfile?: ProfileSummary }).__blokBootProfile = summary;
  console.group(`[blok] profil du ${label} — ${summary.durationMs} ms, ${summary.sampleCount} échantillons`);
  console.table(summary.top);
  if (summary.selectionExits !== undefined) {
    console.info('Sorties de selectionInside :', summary.selectionExits);
  }
  const database = (globalThis as { __blokDatabaseProbe?: { count: number; stacks: Record<string, number> } }).__blokDatabaseProbe;

  const render = (globalThis as { __blokRenderProbe?: Record<string, unknown> }).__blokRenderProbe;
  const loader = (globalThis as { __blokLoaderProbe?: Record<string, unknown> }).__blokLoaderProbe;

  const batch = (globalThis as { __blokBatchProbe?: Record<string, unknown> }).__blokBatchProbe;

  if (batch !== undefined) {
    console.info('Lots de blocs :', batch);
  }
  if (render !== undefined) {
    console.info('Rendu :', render);
  }
  if (loader !== undefined) {
    console.info('Squelette :', loader);
  }
  if (database !== undefined) {
    console.info('Reconstructions de vue database :', database.count, Object.entries(database.stacks).sort((a, b) => b[1] - a[1]).slice(0, 5));
  }
  if (callers !== undefined) {
    console.info('Appelants de la lecture :', Object.entries(callers).sort((a, b) => b[1] - a[1]).slice(0, 8));
  }
  console.info('Détail complet : window.__blokBootProfile');
  console.groupEnd();

  return summary;
}
