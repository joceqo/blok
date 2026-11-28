import { describe, expect, it } from 'vitest';
import {
  advanceFlick,
  flickSteps,
  bufferSteps,
  flickLimit,
  horizontalWheelDelta,
  isDetentWheel,
  onScreenSlice,
  releaseFlick,
  restingFlick,
} from './scroll-flick';

/** The week view on a laptop: seven columns of about this width */
const COLUMN = 150;
const VISIBLE_DAYS = 7;
const PAGE = COLUMN * VISIBLE_DAYS;

describe('horizontalWheelDelta', () => {
  it('follows a trackpad swipe sideways and lets a vertical one through', () => {
    expect(horizontalWheelDelta({ deltaX: 40, deltaY: 3, deltaMode: 0, shiftKey: false }, PAGE)).toBe(40);
    expect(horizontalWheelDelta({ deltaX: 2, deltaY: 60, deltaMode: 0, shiftKey: false }, PAGE)).toBeNull();
  });

  it('reads a plain wheel held with Shift, the only sideways gesture a mouse has', () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true }, PAGE)).toBe(100);
    // Without Shift the same wheel scrolls the hours, as it always did
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false }, PAGE)).toBeNull();
  });

  it('converts the lines and pages Firefox reports into pixels', () => {
    // Three lines sideways: a single notch of a Windows wheel
    expect(horizontalWheelDelta({ deltaX: 3, deltaY: 0, deltaMode: 1, shiftKey: false }, PAGE)).toBe(48);
    expect(horizontalWheelDelta({ deltaX: 1, deltaY: 0, deltaMode: 2, shiftKey: false }, PAGE)).toBe(PAGE);
  });
});

describe('isDetentWheel', () => {
  it('reads a wheel held with Shift, and the lines and pages Firefox reports, as notches', () => {
    expect(isDetentWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true })).toBe(true);
    expect(isDetentWheel({ deltaX: 3, deltaY: 0, deltaMode: 1, shiftKey: false })).toBe(true);
  });

  it('leaves a trackpad swipe to the gesture', () => {
    expect(isDetentWheel({ deltaX: 30, deltaY: 2, deltaMode: 0, shiftKey: false })).toBe(false);
  });
});

describe('advanceFlick', () => {
  /** Runs a whole gesture, collecting what it travelled on the way */
  const swipe = (steps: number[]) =>
    steps.reduce(
      (run, delta) => {
        const step = advanceFlick(run.state, delta, COLUMN);
        return { state: step.state, travelled: run.travelled + step.travelNow };
      },
      { state: restingFlick, travelled: 0 },
    );

  it('follows the fingers pixel for pixel, within a column', () => {
    const run = swipe([-40, -60, -30]);
    expect(run.state.offset).toBe(-130);
    expect(run.travelled).toBe(0);
    expect(swipe([-40, 60]).state.offset).toBe(20);
  });

  it('travels each whole column as it is crossed, and keeps the rest', () => {
    const run = swipe([-COLUMN - 50]);
    expect(run.travelled).toBe(1);
    // What is left is the part of the next column being crossed
    expect(run.state.offset).toBe(-50);
  });

  it('goes as far as it is pushed, and never stops at a wall', () => {
    // A second of macOS momentum. It used to be held as one shift, drawn in
    // full, and that is what made the grid stutter.
    const long = swipe(Array.from({ length: 60 }, () => -300));
    expect(long.travelled).toBe(120);
    const longer = swipe(Array.from({ length: 90 }, () => -300));
    expect(longer.travelled).toBeGreaterThan(long.travelled);
  });

  it('never holds a shift of a whole column, however far the gesture goes', () => {
    for (const run of [swipe([-9000]), swipe([9000]), swipe(Array.from({ length: 40 }, () => 230))]) {
      expect(Math.abs(run.state.offset)).toBeLessThan(COLUMN);
    }
  });

  it('travels back the way it came', () => {
    expect(swipe([COLUMN * 3 + 10]).travelled).toBe(-3);
  });
});

describe('releaseFlick', () => {
  it('lands on the nearest column, and back where it started below half of one', () => {
    expect(releaseFlick({ offset: -120 }, COLUMN)).toBe(1);
    expect(releaseFlick({ offset: -70 }, COLUMN)).toBe(0);
    expect(releaseFlick({ offset: 120 }, COLUMN)).toBe(-1);
  });
});

describe('bufferSteps', () => {
  it('is small and fixed: a rebased gesture never asks it to grow', () => {
    expect(bufferSteps(VISIBLE_DAYS)).toBeLessThanOrEqual(2);
    expect(bufferSteps(1)).toBeGreaterThanOrEqual(1);
  });
});

describe('flickSteps', () => {
  it('reads the grid shift as the days to travel, which run the other way', () => {
    expect(flickSteps(-COLUMN * 3, COLUMN)).toBe(3);
    expect(flickSteps(COLUMN * 2, COLUMN)).toBe(-2);
    expect(flickSteps(-500, 0)).toBe(0);
  });
});

describe('flickLimit', () => {
  it('is the columns on screen', () => {
    expect(flickLimit(COLUMN, VISIBLE_DAYS)).toBe(PAGE);
  });
});

describe('onScreenSlice', () => {
  // The grid draws a buffer of days on each side of the current date and slides
  // it sideways; only this window of it is under the viewer's eyes.
  const buffered = Array.from({ length: 21 }, (_, i) => i - 7);

  it('reads the days the viewer is actually looking at, not the anchored week', () => {
    expect(onScreenSlice(buffered, 7, 0, VISIBLE_DAYS)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Scrolled a week on: today is behind, so nothing of it is on screen
    expect(onScreenSlice(buffered, 7, 7, VISIBLE_DAYS)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(onScreenSlice(buffered, 7, -3, VISIBLE_DAYS)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });

  it('stays inside the buffer when the scroll runs past its edge', () => {
    expect(onScreenSlice(buffered, 7, 40, VISIBLE_DAYS)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(onScreenSlice(buffered, 7, -40, VISIBLE_DAYS)).toEqual([-7, -6, -5, -4, -3, -2, -1]);
  });
});
