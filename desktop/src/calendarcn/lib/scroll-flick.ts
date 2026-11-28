/**
 * One scroll gesture over a calendar that pages: the week grid sideways by
 * columns of days, the month grid downwards by rows of weeks. A "step" is one
 * of those.
 *
 * The grid follows the fingers one pixel for one pixel and never stops at a
 * wall: a gesture goes as far as it is pushed. What it must not do is hold
 * the whole journey as one shift and draw every day of it — that is what grew
 * the buffer to a hundred and fifty columns mid-swipe, regenerating every
 * column and every recurring event on the way, and made a brisk swipe stutter.
 *
 * So the gesture is rebased instead: every whole step it crosses is travelled
 * at once and taken out of the shift, which therefore stays under one step.
 * The grid draws a small, fixed buffer, and the calendar moves continuously
 * under the fingers.
 */

/** A line of a wheel that reports its steps in lines (`deltaMode` 1) */
const LINE_DELTA_PX = 16;

/**
 * Steps the grid draws on each side of the visible ones. A gesture is rebased
 * every whole step, so its shift never reaches one and this never has to grow.
 */
const BUFFER_STEPS = 2;

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

/** Where a gesture stands, between two steps */
export interface FlickState {
  /** Pixels the grid is shifted by. Always less than one step. */
  offset: number;
}

/** What one wheel event does */
export interface FlickStep {
  state: FlickState;
  /** Steps to travel now: the whole ones this event crossed */
  travelNow: number;
}

/** No gesture under way */
export const restingFlick: FlickState = { offset: 0 };

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
 * Notches come far apart and carry a fraction of a column, so a gesture made
 * of them would be over between any two of them. Each is a day of its own
 * instead. Firefox reports a wheel in lines or pages rather than pixels.
 */
export function isDetentWheel(event: WheelLike): boolean {
  return event.shiftKey || event.deltaMode !== 0;
}

/** A page of steps: what a wheel reporting in pages (`deltaMode` 2) asks for */
export function flickLimit(stepSize: number, pageSteps: number): number {
  return Math.max(1, pageSteps) * Math.max(0, stepSize);
}

/** The steps a grid shift stands for. The grid shifts against the direction of travel. */
export function flickSteps(offset: number, stepSize: number): number {
  return stepSize > 0 ? -Math.round(offset / stepSize) : 0;
}

/** Steps the grid draws on each side of the visible ones, a fixed number */
export function bufferSteps(pageSteps: number): number {
  return Math.max(1, Math.min(pageSteps, BUFFER_STEPS));
}

/**
 * Takes one wheel event into the gesture.
 *
 * Whole steps are handed back to be travelled at once rather than held: the
 * shift that remains is always under one step, so the grid never has to draw
 * further than its buffer however far the gesture goes.
 */
export function advanceFlick(
  state: FlickState,
  deltaPx: number,
  stepSize: number,
): FlickStep {
  const offset = state.offset + deltaPx;
  if (stepSize <= 0) return { state: { offset }, travelNow: 0 };
  // Whole steps only: what is left is the part of a step still being crossed
  const travelNow = Math.trunc(-offset / stepSize);
  return { state: { offset: offset + travelNow * stepSize }, travelNow };
}

/** The last step to travel once the wheel goes quiet, nearest to where it stopped */
export function releaseFlick(state: FlickState, stepSize: number): number {
  return flickSteps(state.offset, stepSize);
}

/**
 * The steps under the viewer's eyes, within the buffered ones the grid draws
 * and slides.
 *
 * The anchored week is not what is on screen: it stays on the current date
 * while a gesture travels, which is how the "now" line came to be drawn over a
 * week months away from today.
 */
export function onScreenSlice<T>(
  buffered: T[],
  bufferSize: number,
  scrolledSteps: number,
  pageSteps: number,
): T[] {
  const last = Math.max(0, buffered.length - pageSteps);
  const start = Math.min(Math.max(bufferSize + scrolledSteps, 0), last);
  return buffered.slice(start, start + pageSteps);
}
