import { describe, expect, it } from 'vitest';
import { summarizeProfile, type ProfilerTrace } from './boot-profile';

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
