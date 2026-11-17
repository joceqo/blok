import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSkeletonHandoff } from '../../../../src/components/utils/skeleton-handoff';
import * as motion from '../../../../src/components/utils/reduced-motion';

type AnimateCall = { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions };

const last = (keyframes: Keyframe[]): Keyframe => keyframes[keyframes.length - 1] ?? {};

const rect = (top: number, height: number, width = 600, left = 0): DOMRect =>
  ({ top, left, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });

describe('runSkeletonHandoff', () => {
  const calls: AnimateCall[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    Element.prototype.animate = vi.fn(function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      calls.push({ el: this, keyframes, options });

      return { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, 'animate');
  });

  const make = (n: number, tops: number[]): HTMLElement[] => Array.from({ length: n }, (_, i) => {
    const el = document.createElement('div');

    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(tops[i] ?? 0, 20));

    return el;
  });

  it.each([false, true])('fades the header and body together (reduced motion: %s)', async (reduced) => {
    vi.spyOn(motion, 'prefersReducedMotion').mockReturnValue(reduced);
    const content = document.createElement('div');
    const header = document.createElement('header');

    await runSkeletonHandoff({ bars: make(2, [0, 30]), targets: [], content, companions: [header] });

    const bodyAnimation = calls.find(call => call.el === content);
    const headerAnimation = calls.find(call => call.el === header);

    expect(headerAnimation?.keyframes).toEqual(bodyAnimation?.keyframes);
    expect(headerAnimation?.options).toEqual(bodyAnimation?.options);
  });


  it('fades extra bars in place and fades the content in', async () => {
    const bars = make(3, [0, 30, 60]);
    const targets = make(1, [0]);
    const content = document.createElement('div');

    await runSkeletonHandoff({ bars, targets, content });

    const extra = calls.filter(call => call.el === bars[2]);

    expect(extra).toHaveLength(1);
    expect(extra[0].keyframes.some(frame => frame.transform !== undefined)).toBe(false);
    expect(calls.some(call => call.el === content)).toBe(true);
  });

  it('fades a bar in place when its block is hidden, instead of flying it to the viewport corner', async () => {
    const bars = make(1, [40]);
    const hidden = document.createElement('div');

    // A collapsed toggle's child is display:none, so its rect is all zeros.
    vi.spyOn(hidden, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 0, 0));

    await runSkeletonHandoff({ bars, targets: [hidden], content: document.createElement('div') });

    const barCall = calls.find(call => call.el === bars[0]);

    expect(barCall?.keyframes.some(frame => frame.transform !== undefined)).toBe(false);
    expect(last(barCall?.keyframes ?? []).opacity).toBe(0);
  });



  it('a bar fades from its current breathing opacity without flashing', async () => {
    const bars = make(2, [0, 30]);
    const targets = make(1, [100]);

    bars.forEach(bar => bar.style.setProperty('opacity', '0.72'));

    await runSkeletonHandoff({ bars, targets, content: document.createElement('div') });

    // Both bars fade from their current opacity, including bars without a target.
    bars.forEach(bar => {
      const call = calls.find(c => c.el === bar);

      expect(Number(call?.keyframes[0].opacity)).toBe(0.72);
      expect(call?.options.fill).toBe('both');
    });
  });


  it('under reduced motion only crossfades: no transforms, no blur', async () => {
    vi.spyOn(motion, 'prefersReducedMotion').mockReturnValue(true);
    const bars = make(1, [0]);
    const targets = make(1, [100]);

    await runSkeletonHandoff({ bars, targets, content: document.createElement('div') });

    expect(calls.length).toBeGreaterThan(0);
    calls.forEach((call) => {
      call.keyframes.forEach(frame => {
        expect(frame.transform).toBeUndefined();
        expect(frame.filter).toBeUndefined();
      });
    });
  });

  describe('when an animation is cancelled', () => {
    beforeEach(() => {
      Element.prototype.animate = vi.fn(() =>
        ({ finished: Promise.reject(new DOMException('', 'AbortError')), cancel: vi.fn() }) as unknown as Animation);
    });

    it('still resolves on the motion path', async () => {
      await expect(runSkeletonHandoff({ bars: make(2, [0, 30]), targets: make(1, [100]), content: document.createElement('div') })).resolves.toBeUndefined();
    });

    it('still resolves on the reduced-motion path', async () => {
      vi.spyOn(motion, 'prefersReducedMotion').mockReturnValue(true);

      await expect(runSkeletonHandoff({ bars: make(1, [0]), targets: make(1, [100]), content: document.createElement('div') })).resolves.toBeUndefined();
    });
  });

  it('resolves at once when animate is unavailable', async () => {
    Reflect.deleteProperty(Element.prototype, 'animate');

    await expect(runSkeletonHandoff({ bars: make(1, [0]), targets: make(1, [0]), content: document.createElement('div') })).resolves.toBeUndefined();
  });
});

it('keeps every loading region stationary even when arriving chunk targets move or are distant', async () => {
  const bars = [document.createElement('div'), document.createElement('div')];
  const target = document.createElement('div');
  const content = document.createElement('div');
  const animate = vi.fn(() => ({finished: Promise.resolve(), cancel: vi.fn()} as unknown as Animation));
  const rects = [target, ...bars].map(el => vi.spyOn(el, 'getBoundingClientRect'));
  [content, ...bars].forEach(el => { el.animate = animate; });
  try {
    await runSkeletonHandoff({bars, targets: [target], content});
    for (const spy of rects) expect(spy).not.toHaveBeenCalled();
    for (const [frames, options] of animate.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions][]) {
      expect(frames.every(frame => frame.transform === undefined && frame.filter === undefined)).toBe(true);
      expect(options.delay ?? 0).toBe(0);
      expect(Number(options.duration)).toBeLessThanOrEqual(180);
    }
  } finally { vi.restoreAllMocks(); }
});
