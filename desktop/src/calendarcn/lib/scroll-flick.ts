/**
 * One sideways gesture over the time grid, from the first wheel event to the
 * day it lands on.
 *
 * A trackpad does not stop when the fingers leave it: macOS keeps sending
 * momentum events for well over a second, and Windows precision trackpads do
 * the same. Adding all of them to one jump sent the calendar months away from
 * a single flick, and grew the grid's buffer to hundreds of columns while it
 * travelled. So a gesture carries at most one page of columns, and whatever
 * momentum follows is ignored until the wheel goes quiet.
 */

/** A line of a wheel that reports its steps in lines (`deltaMode` 1) */
const LINE_DELTA_PX = 16;

/** The pixels one of a wheel event's steps stands for */
function wheelUnit(deltaMode: number, pageWidth: number): number {
  if (deltaMode === 1) return LINE_DELTA_PX;
  if (deltaMode === 2) return pageWidth;
  return 1;
}

/** The part of a wheel event this grid reads */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}

/** Where a gesture stands: its grid shift, and whether it has already landed */
export interface FlickState {
  /** Pixels the grid is shifted by, against the direction of travel */
  offset: number;
  /** The gesture reached a full page and has moved: its momentum is spent */
  spent: boolean;
}

/** What one wheel event does: the gesture's new state, and the days to travel now */
export interface FlickStep {
  state: FlickState;
  /** `0` while the gesture is still under way */
  commitDays: number;
}

/** No gesture under way */
export const restingFlick: FlickState = { offset: 0, spent: false };

/**
 * The sideways pixels a wheel event asks for, or `null` when it is a vertical
 * scroll the hours should keep.
 *
 * A mouse has no sideways wheel, so Shift with a plain wheel is the only
 * gesture it can make, and Firefox reports its steps in lines or pages rather
 * than pixels.
 */
export function horizontalWheelDelta(
  event: WheelLike,
  pageWidth: number,
): number | null {
  const unit = wheelUnit(event.deltaMode, pageWidth);
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    return event.deltaX * unit;
  }
  // A wheel held with Shift, the sideways gesture of a mouse. Only when the
  // device sends no deltaX of its own, which macOS and Chrome already do.
  if (event.shiftKey && event.deltaX === 0 && event.deltaY !== 0) {
    return event.deltaY * unit;
  }
  return null;
}

/**
 * Whether this is one notch of a mouse wheel rather than part of a swipe.
 *
 * Notches come seconds apart and carry a fraction of a page, so adding them up
 * the way a swipe is added up would never move the view. Each is a step of its
 * own instead. A mouse has no sideways wheel, so Shift is how it scrolls
 * sideways, and Firefox reports a wheel in lines or pages rather than pixels.
 */
export function isDetentWheel(event: WheelLike): boolean {
  return event.shiftKey || event.deltaMode !== 0;
}

/** How far one gesture may shift the grid: the columns on screen, and no more */
export function flickLimit(dayColumnWidth: number, visibleDays: number): number {
  return Math.max(1, visibleDays) * Math.max(0, dayColumnWidth);
}

/** The days a grid shift stands for. The grid shifts against the direction of travel. */
export function flickDays(offset: number, dayColumnWidth: number): number {
  return dayColumnWidth > 0 ? -Math.round(offset / dayColumnWidth) : 0;
}

/** Takes one wheel event into the gesture */
export function advanceFlick(
  state: FlickState,
  deltaPx: number,
  dayColumnWidth: number,
  visibleDays: number,
): FlickStep {
  if (state.spent) return { state, commitDays: 0 };

  const limit = flickLimit(dayColumnWidth, visibleDays);
  const offset = Math.min(Math.max(state.offset + deltaPx, -limit), limit);
  if (limit > 0 && Math.abs(offset) >= limit) {
    return {
      state: { offset, spent: true },
      commitDays: flickDays(offset, dayColumnWidth),
    };
  }
  return { state: { offset, spent: false }, commitDays: 0 };
}

/**
 * The days to travel when the wheel goes quiet, snapping to the nearest stop.
 *
 * `snapStep` is how far the view moves in one step: a day where it shows a
 * rolling range, a whole week where it re-anchors on the first day of one.
 * Landing between two stops of a view that re-anchors would be pulled back,
 * which is why a short gesture there must either carry a page or hold still.
 */
export function releaseFlick(
  state: FlickState,
  dayColumnWidth: number,
  snapStep = 1,
): number {
  if (state.spent) return 0;
  const step = Math.max(1, snapStep);
  if (step === 1) return flickDays(state.offset, dayColumnWidth);
  return flickDays(state.offset, dayColumnWidth * step) * step;
}

/**
 * The columns under the viewer's eyes, within the buffered ones the grid draws
 * and slides sideways.
 *
 * The anchored week is not what is on screen: it stays on the current date
 * while a gesture travels, which is how the "now" line came to be drawn over a
 * week months away from today.
 */
export function onScreenSlice<T>(
  buffered: T[],
  bufferSize: number,
  scrollDaysDelta: number,
  visibleDays: number,
): T[] {
  const last = Math.max(0, buffered.length - visibleDays);
  const start = Math.min(Math.max(bufferSize + scrollDaysDelta, 0), last);
  return buffered.slice(start, start + visibleDays);
}
