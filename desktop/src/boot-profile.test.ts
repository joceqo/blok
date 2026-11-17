import { describe, expect, it } from 'vitest';
import { shouldStopProfile, summarizeProfile, type ProfilerTrace } from './boot-profile';

/**
 * Builds a trace whose samples sit one millisecond apart.
 * @param frames - function names, innermost last for each stack
 * @param stacks - for each sample, the index of the stack it was taken in
 */
const traceOf = (frames: string[][], stacks: number[]): ProfilerTrace => {
  const frameList: { name: string }[] = [];
  const stackList: { frameId: number; parentId?: number }[] = [];
  const stackTop: number[] = [];

  frames.forEach(chain => {
    let parentId: number | undefined;
    chain.forEach(name => {
      frameList.push({ name });
      stackList.push({ frameId: frameList.length - 1, parentId });
      parentId = stackList.length - 1;
    });
    stackTop.push(stackList.length - 1);
  });

  return {
    resources: [],
    frames: frameList,
    stacks: stackList,
    samples: stacks.map((stack, index) => ({ timestamp: index, stackId: stackTop[stack] })),
  };
};

describe('summarizeProfile', () => {
  it('charges a sample to the function running at the top of its stack', () => {
    const trace = traceOf([['boot', 'render'], ['boot', 'hydrate']], [0, 0, 0, 1]);

    const { top } = summarizeProfile(trace);

    expect(top[0]).toMatchObject({ name: 'render', selfMs: 3 });
    expect(top.find(row => row.name === 'hydrate')).toMatchObject({ selfMs: 1 });
  });

  it('credits a caller the whole time spent beneath it, counted once', () => {
    const trace = traceOf([['boot', 'render'], ['boot', 'hydrate']], [0, 1]);

    const { top } = summarizeProfile(trace);

    expect(top.find(row => row.name === 'boot')).toMatchObject({ selfMs: 0, totalMs: 2 });
  });

  it('counts a recursive frame once per sample, not once per level', () => {
    const trace = traceOf([['walk', 'walk', 'walk']], [0, 0]);

    const { top } = summarizeProfile(trace);

    expect(top.find(row => row.name === 'walk')).toMatchObject({ totalMs: 2 });
  });

  it('names an anonymous frame rather than dropping it', () => {
    const trace = traceOf([['', 'render']], [0]);

    const { top } = summarizeProfile(trace);

    expect(top.map(row => row.name)).toContain('(anonyme)');
  });

  it('reports the wall time the samples span', () => {
    const trace = traceOf([['boot']], [0, 0, 0]);

    expect(summarizeProfile(trace)).toMatchObject({ sampleCount: 3, durationMs: 3 });
  });

  it('ignores a sample taken while no JavaScript was running', () => {
    const trace = traceOf([['boot']], [0]);
    trace.samples.push({ timestamp: 9 });

    const { top, sampleCount } = summarizeProfile(trace);

    expect(sampleCount).toBe(2);
    expect(top).toHaveLength(1);
  });

  it('keeps only the heaviest frames when asked for a short list', () => {
    const trace = traceOf([['a'], ['b'], ['c']], [0, 0, 0, 1, 1, 2]);

    expect(summarizeProfile(trace, { limit: 2 }).top.map(row => row.name)).toEqual(['a', 'b']);
  });
});

describe('summarizeProfile — noms minifiés', () => {
  it('ne confond pas deux fonctions homonymes venues de fichiers différents', () => {
    // Rolldown mangle les fonctions top-level en « Ce », « yt »… par chunk.
    // Agréger sur le seul nom additionne des fonctions sans rapport.
    const trace: ProfilerTrace = {
      resources: ['/assets/shell.js', '/assets/database.js'],
      frames: [
        { name: 'Ce', resourceId: 0, line: 12, column: 3 },
        { name: 'Ce', resourceId: 1, line: 44, column: 9 },
      ],
      stacks: [{ frameId: 0 }, { frameId: 1 }],
      samples: [{ timestamp: 0, stackId: 0 }, { timestamp: 1, stackId: 1 }],
    };

    const { top } = summarizeProfile(trace);

    expect(top).toHaveLength(2);
    expect(top.map(row => row.location)).toEqual(['/assets/shell.js:12:3', '/assets/database.js:44:9']);
  });

  it('garde ensemble les appels d\'une même fonction', () => {
    const trace: ProfilerTrace = {
      resources: ['/assets/shell.js'],
      frames: [{ name: 'Ce', resourceId: 0, line: 12, column: 3 }],
      stacks: [{ frameId: 0 }],
      samples: [{ timestamp: 0, stackId: 0 }, { timestamp: 1, stackId: 0 }],
    };

    expect(summarizeProfile(trace).top).toHaveLength(1);
  });

  it('nomme une frame sans emplacement plutôt que de la jeter', () => {
    const trace: ProfilerTrace = {
      resources: [],
      frames: [{ name: 'eval' }],
      stacks: [{ frameId: 0 }],
      samples: [{ timestamp: 0, stackId: 0 }],
    };

    expect(summarizeProfile(trace).top[0]).toMatchObject({ name: 'eval', location: '(sans source)' });
  });
});

describe('shouldStopProfile', () => {
  const options = { quietMs: 3_000, maxMs: 120_000 };

  it('waits while the thread has not started working yet', () => {
    // The freeze begins at ~900 ms: stopping at the idle before it profiles nothing.
    expect(shouldStopProfile({ startedAt: 0, lastBusyAt: null, now: 300 }, options)).toBe(false);
  });

  it('waits while long tasks are still landing', () => {
    expect(shouldStopProfile({ startedAt: 0, lastBusyAt: 29_000, now: 30_000 }, options)).toBe(false);
  });

  it('stops once the thread has been quiet long enough after working', () => {
    expect(shouldStopProfile({ startedAt: 0, lastBusyAt: 42_000, now: 45_000 }, options)).toBe(true);
  });

  it('stops at the safety net even if nothing was ever observed', () => {
    expect(shouldStopProfile({ startedAt: 0, lastBusyAt: null, now: 120_000 }, options)).toBe(true);
  });

  it('keeps sampling through a gap shorter than the quiet window', () => {
    expect(shouldStopProfile({ startedAt: 0, lastBusyAt: 40_000, now: 42_999 }, options)).toBe(false);
  });
});
