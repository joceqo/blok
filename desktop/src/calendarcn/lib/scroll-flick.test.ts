import { describe, expect, it } from 'vitest';
import {
  advanceFlick,
  flickSteps,
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

/** Runs a whole gesture through the tracker */
const swipe = (steps: number[]) =>
  steps.reduce(
    (state, delta) => advanceFlick(state, delta, COLUMN, VISIBLE_DAYS),
    restingFlick,
  );

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
  it('follows the fingers pixel for pixel', () => {
    expect(swipe([-40, -60, -50]).offset).toBe(-150);
    expect(swipe([-40, 60]).offset).toBe(20);
  });

  it('keeps following past a page, with the give of a rubber band', () => {
    const past = swipe([-PAGE - 200]);
    expect(past.offset).toBeLessThan(-PAGE);
    // It gives, rather than running away with the momentum
    expect(past.offset).toBeGreaterThan(-PAGE - COLUMN);
  });

  it('never gives more than a column, so the drawn buffer stays a fixed size', () => {
    // A second of macOS momentum asks for eighteen thousand pixels
    const long = swipe(Array.from({ length: 60 }, () => -300));
    expect(long.offset).toBeGreaterThanOrEqual(-PAGE - COLUMN);
    expect(swipe([PAGE * 40]).offset).toBeLessThanOrEqual(PAGE + COLUMN);
  });
});

describe('releaseFlick', () => {
  it('lands on the nearest column, and back where it started below half of one', () => {
    expect(releaseFlick(swipe([-200]), COLUMN, VISIBLE_DAYS)).toBe(1);
    expect(releaseFlick(swipe([-70]), COLUMN, VISIBLE_DAYS)).toBe(0);
    expect(releaseFlick(swipe([-520]), COLUMN, VISIBLE_DAYS)).toBe(3);
    expect(releaseFlick(swipe([160]), COLUMN, VISIBLE_DAYS)).toBe(-1);
  });

  it('travels a page at the most, whatever the momentum asked for', () => {
    // This is the June-to-November swipe: sixty momentum events, 18000px
    const flick = swipe(Array.from({ length: 60 }, () => -300));
    expect(flickSteps(flick.travelled, COLUMN)).toBeGreaterThan(100);
    expect(releaseFlick(flick, COLUMN, VISIBLE_DAYS)).toBe(VISIBLE_DAYS);
    expect(releaseFlick(swipe([PAGE * 9]), COLUMN, VISIBLE_DAYS)).toBe(-VISIBLE_DAYS);
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
