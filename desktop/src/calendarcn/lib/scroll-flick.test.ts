import { describe, expect, it } from 'vitest';
import {
  advanceFlick,
  flickDays,
  flickLimit,
  horizontalWheelDelta,
  isDetentWheel,
  restingFlick,
  onScreenSlice,
  releaseFlick,
} from './scroll-flick';

/** The week view on a laptop: seven columns of about this width */
const COLUMN = 150;
const VISIBLE_DAYS = 7;

describe('horizontalWheelDelta', () => {
  it('follows a trackpad swipe sideways and lets a vertical one through', () => {
    expect(horizontalWheelDelta({ deltaX: 40, deltaY: 3, deltaMode: 0, shiftKey: false }, 1050)).toBe(40);
    expect(horizontalWheelDelta({ deltaX: 2, deltaY: 60, deltaMode: 0, shiftKey: false }, 1050)).toBeNull();
  });

  it('reads a plain wheel held with Shift, the only sideways gesture a mouse has', () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true }, 1050)).toBe(100);
    // Without Shift the same wheel scrolls the hours, as it always did
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false }, 1050)).toBeNull();
  });

  it('converts the lines and pages Firefox reports into pixels', () => {
    // Three lines sideways: a single notch of a Windows wheel
    expect(horizontalWheelDelta({ deltaX: 3, deltaY: 0, deltaMode: 1, shiftKey: false }, 1050)).toBe(48);
    expect(horizontalWheelDelta({ deltaX: 1, deltaY: 0, deltaMode: 2, shiftKey: false }, 1050)).toBe(1050);
  });
});

describe('isDetentWheel', () => {
  // A mouse wheel turns in notches, far apart and far too small to add up to a
  // gesture. Each notch is a step of its own, or the view would never move.
  it('reads a wheel held with Shift as a notch', () => {
    expect(isDetentWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true })).toBe(true);
    expect(isDetentWheel({ deltaX: 100, deltaY: 0, deltaMode: 0, shiftKey: true })).toBe(true);
  });

  it('reads the lines and pages Firefox reports as notches', () => {
    expect(isDetentWheel({ deltaX: 3, deltaY: 0, deltaMode: 1, shiftKey: false })).toBe(true);
    expect(isDetentWheel({ deltaX: 1, deltaY: 0, deltaMode: 2, shiftKey: false })).toBe(true);
  });

  it('leaves a trackpad swipe to the gesture', () => {
    expect(isDetentWheel({ deltaX: 30, deltaY: 2, deltaMode: 0, shiftKey: false })).toBe(false);
  });
});

describe('advanceFlick', () => {
  it('crosses at most one page per gesture, however long the momentum runs', () => {
    // A brisk two-finger swipe on macOS: the momentum keeps firing for over a
    // second, and every one of those events used to be added to the same jump.
    let state = restingFlick;
    let travelled = 0;
    for (let i = 0; i < 60; i++) {
      const step = advanceFlick(state, -300, COLUMN, VISIBLE_DAYS);
      state = step.state;
      travelled += step.commitDays;
    }
    expect(travelled).toBe(VISIBLE_DAYS);
    expect(Math.abs(state.offset)).toBeLessThanOrEqual(flickLimit(COLUMN, VISIBLE_DAYS));
  });

  it('spends the gesture once, so the trailing momentum moves nothing', () => {
    const start = advanceFlick(restingFlick, -COLUMN * VISIBLE_DAYS, COLUMN, VISIBLE_DAYS);
    expect(start.commitDays).toBe(VISIBLE_DAYS);
    expect(start.state.spent).toBe(true);
    expect(advanceFlick(start.state, -5000, COLUMN, VISIBLE_DAYS).commitDays).toBe(0);
  });

  it('holds a short gesture until it is released', () => {
    const step = advanceFlick(restingFlick, -200, COLUMN, VISIBLE_DAYS);
    expect(step.commitDays).toBe(0);
    expect(step.state.offset).toBe(-200);
  });
});

describe('releaseFlick', () => {
  it('snaps to the nearest column, and back to where it started below half of one', () => {
    expect(releaseFlick({ offset: -200, spent: false }, COLUMN)).toBe(1);
    expect(releaseFlick({ offset: -70, spent: false }, COLUMN)).toBe(0);
    expect(releaseFlick({ offset: 160, spent: false }, COLUMN)).toBe(-1);
  });

  it('moves nothing more once the gesture has already been spent', () => {
    expect(releaseFlick({ offset: -1050, spent: true }, COLUMN)).toBe(0);
  });
});

describe('releaseFlick with a snap step', () => {
  // The week view re-anchors on the first day of the week, so landing mid-week
  // is pulled back: once a page, a gesture must carry a whole one.
  it('travels a whole page, or none of it', () => {
    expect(releaseFlick({ offset: -COLUMN * 4, spent: false }, COLUMN, VISIBLE_DAYS)).toBe(VISIBLE_DAYS);
    expect(releaseFlick({ offset: COLUMN * 5, spent: false }, COLUMN, VISIBLE_DAYS)).toBe(-VISIBLE_DAYS);
  });

  it('holds still for a gesture that did not carry half a page', () => {
    expect(releaseFlick({ offset: -COLUMN * 3, spent: false }, COLUMN, VISIBLE_DAYS)).toBe(0);
    expect(releaseFlick({ offset: -200, spent: false }, COLUMN, VISIBLE_DAYS)).toBe(0);
  });

  it('still moves day by day where the view does not re-anchor', () => {
    expect(releaseFlick({ offset: -200, spent: false }, COLUMN, 1)).toBe(1);
  });
});

describe('flickDays', () => {
  it('reads the grid shift as the days to travel, which run the other way', () => {
    expect(flickDays(-COLUMN * 3, COLUMN)).toBe(3);
    expect(flickDays(COLUMN * 2, COLUMN)).toBe(-2);
    expect(flickDays(-500, 0)).toBe(0);
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
