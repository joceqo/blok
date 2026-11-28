/**
 * One scroll gesture over a calendar that pages: the week grid sideways by
 * columns of days, the month grid downwards by rows of weeks. A "step" is one
 * of those, and a "page" is the ones on screen.
 *
 * The grid follows the fingers one pixel for one pixel, which is what makes
 * the gesture feel like the calendar is being dragged. What it must not do is
 * take the momentum for travel: a trackpad does not stop when the fingers
 * leave it, and macOS keeps sending events for over a second. Adding all of
 * them to one jump, with no cap, sent the calendar from June to November on a
 * single swipe, and grew the grid's buffer to a hundred and fifty columns on
 * the way.
 *
 * So the gesture is capped where it is not felt — in how far it travels — and
 * left alone where it is: past a page, the grid still follows, with the give
 * of a rubber band rather than a wall.
 */

/** A line of a wheel that reports its steps in lines (`deltaMode` 1) */
const LINE_DELTA_PX = 16;

/** How much of each pixel past a page the grid still follows */
const RUBBER_BAND = 0.15;

/**
 * The furthest the grid goes past a page, in steps. The buffer it draws is
 * sized once from this, so no gesture can make it grow — growing it mid-swipe
 * meant regenerating every column and every recurring event on the way, which
 * is what turned a brisk swipe into a stutter.
 */
const MAX_GIVE_STEPS = 1;

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

/** Where a gesture stands */
export interface FlickState {
  /** Everything the gesture has asked for, momentum included */
  travelled: number;
  /** Pixels the grid is shifted by: the above, with give past a page */
  offset: number;
}

/** No gesture under way */
export const restingFlick: FlickState = { travelled: 0, offset: 0 };

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

/** A page of steps: as far as one gesture travels, however long it runs */
export function flickLimit(stepSize: number, pageSteps: number): number {
  return Math.max(1, pageSteps) * Math.max(0, stepSize);
}

/** The steps a grid shift stands for. The grid shifts against the direction of travel. */
export function flickSteps(offset: number, stepSize: number): number {
  return stepSize > 0 ? -Math.round(offset / stepSize) : 0;
}

/** Past a page, each pixel still moves the grid, by less and less of itself */
function withGive(
  travelled: number,
  limit: number,
  stepSize: number,
): number {
  if (limit <= 0 || Math.abs(travelled) <= limit) return travelled;
  const past = Math.abs(travelled) - limit;
  const give = Math.min(past * RUBBER_BAND, stepSize * MAX_GIVE_STEPS);
  return Math.sign(travelled) * (limit + give);
}

/** Steps the grid draws on each side of the visible ones, a fixed number */
export function bufferSteps(pageSteps: number): number {
  return Math.max(1, pageSteps) + MAX_GIVE_STEPS;
}

/** Takes one wheel event into the gesture */
export function advanceFlick(
  state: FlickState,
  deltaPx: number,
  stepSize: number,
  pageSteps: number,
): FlickState {
  const travelled = state.travelled + deltaPx;
  return {
    travelled,
    offset: withGive(
      travelled,
      flickLimit(stepSize, pageSteps),
      stepSize,
    ),
  };
}

/**
 * The steps to travel once the wheel goes quiet.
 *
 * Capped at the columns on screen. Everything past that is momentum the
 * fingers never asked for, and letting it through is what sent the calendar
 * months away from a flick.
 */
export function releaseFlick(
  state: FlickState,
  stepSize: number,
  pageSteps: number,
): number {
  const days = flickSteps(state.travelled, stepSize);
  const limit = Math.max(1, pageSteps);
  return Math.min(Math.max(days, -limit), limit);
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
