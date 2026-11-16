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
}

const ANONYMOUS = '(anonyme)';

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
const framesOf = (trace: ProfilerTrace, stackId: number): string[] => {
  const names: string[] = [];
  let cursor: number | undefined = stackId;

  while (cursor !== undefined) {
    const stack: ProfilerStack | undefined = trace.stacks[cursor];
    if (stack === undefined) {
      break;
    }
    names.push(trace.frames[stack.frameId]?.name || ANONYMOUS);
    cursor = stack.parentId;
  }

  return names;
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
  const rows = new Map<string, { selfMs: number; totalMs: number }>();
  const rowFor = (name: string): { selfMs: number; totalMs: number } => {
    const existing = rows.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created = { selfMs: 0, totalMs: 0 };
    rows.set(name, created);

    return created;
  };

  let durationMs = 0;

  trace.samples.forEach((sample, index) => {
    const weight = weights[index];
    durationMs += weight;

    if (sample.stackId === undefined) {
      return;
    }

    const names = framesOf(trace, sample.stackId);
    if (names.length === 0) {
      return;
    }

    rowFor(names[0]).selfMs += weight;
    // A recursive frame appears at several levels of one stack; it waited once.
    new Set(names).forEach(name => {
      rowFor(name).totalMs += weight;
    });
  });

  const top = [...rows.entries()]
    .map(([name, totals]) => ({
      name,
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

/**
 * Whether this load asked to be profiled, through `?profile=1`.
 */
const profileRequested = (): boolean => new URLSearchParams(location.search).get('profile') === '1';

/**
 * Starts sampling, if this load asked for it and the browser allows it.
 *
 * Call it as early as the entry module runs: the freeze being chased starts
 * before anything is painted.
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
    console.info('[blok] profil du démarrage en cours…');
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

  const trace = await profiler.stop();
  const summary = summarizeProfile(trace);

  (globalThis as { __blokBootProfile?: ProfileSummary }).__blokBootProfile = summary;
  console.group(`[blok] profil du ${label} — ${summary.durationMs} ms, ${summary.sampleCount} échantillons`);
  console.table(summary.top);
  console.info('Détail complet : window.__blokBootProfile');
  console.groupEnd();

  return summary;
}
