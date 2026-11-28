"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  advanceFlick,
  flickLimit,
  horizontalWheelDelta,
  isDetentWheel,
  releaseFlick,
  restingFlick,
  type FlickState,
} from "../lib/scroll-flick";
import { usePrefersReducedMotion } from "./use-media-query";

interface UseVerticalScrollOptions {
  /** Ref to the scrollable container element */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Height of a single row in pixels */
  rowHeight: number;
  /** Rows on screen: the furthest one gesture travels */
  visibleRows: number;
  /** Called when scroll settles — receives the number of rows scrolled */
  onNavigate: (rowsDelta: number) => void;
  /** Disable scroll handling (e.g., during drag) */
  disabled?: boolean;
}

interface UseVerticalScrollReturn {
  /** Current scroll offset in pixels (for translateY) */
  scrollOffset: number;
  /** Slide animation offset in pixels (for button/keyboard nav) */
  slideOffset: number;
  /** Whether the user is actively scrolling */
  isScrolling: boolean;
  /** Whether a snap/slide animation is in progress */
  isAnimating: boolean;
  /** Trigger a slide animation for programmatic navigation */
  triggerSlideAnimation: (rowsDelta: number) => void;
}

/** Debounce time after last wheel event before snapping */
const SCROLL_END_DEBOUNCE_MS = 150;

/** Duration of snap/slide CSS transition */
const SNAP_ANIMATION_MS = 200;

export function useVerticalScroll({
  containerRef,
  rowHeight,
  visibleRows,
  onNavigate,
  disabled,
}: UseVerticalScrollOptions): UseVerticalScrollReturn {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [slideOffset, setSlideOffset] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  // Snaps and slides jump straight to their end instead of animating
  const prefersReducedMotion = usePrefersReducedMotion();

  const restTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout>>(null);
  /** What the snap in flight still has to do, so a new gesture can let it finish */
  const pendingSnap = useRef<(() => void) | null>(null);
  const flick = useRef<FlickState>(restingFlick);
  const onNavigateRef = useRef(onNavigate);
  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  /** Runs the snap in flight at once. A gesture that interrupts one never loses it. */
  const flushSnap = useCallback(() => {
    if (snapTimer.current) clearTimeout(snapTimer.current);
    snapTimer.current = null;
    const finish = pendingSnap.current;
    pendingSnap.current = null;
    finish?.();
  }, []);

  /**
   * Ends the slide. It does NOT end the gesture: a trackpad is still sending
   * momentum, and only silence ends a gesture.
   */
  const rest = useCallback(() => {
    setScrollOffset(0);
    setIsAnimating(false);
    setIsScrolling(false);
  }, []);

  /** Slides to the row the gesture landed on, then moves the calendar there */
  const snapAndNavigate = useCallback(
    (rowsDelta: number) => {
      if (rowHeight <= 0) return;
      flushSnap();

      if (rowsDelta === 0) {
        // Short of half a row: back to where the gesture started
        if (prefersReducedMotion) {
          rest();
          return;
        }
        setIsAnimating(true);
        setScrollOffset(0);
        pendingSnap.current = rest;
        snapTimer.current = setTimeout(flushSnap, SNAP_ANIMATION_MS);
        return;
      }

      if (prefersReducedMotion) {
        onNavigateRef.current(rowsDelta);
        rest();
        return;
      }

      // The grid shifts against the direction of travel
      setIsAnimating(true);
      setScrollOffset(-rowsDelta * rowHeight);
      pendingSnap.current = () => {
        onNavigateRef.current(rowsDelta);
        rest();
      };
      snapTimer.current = setTimeout(flushSnap, SNAP_ANIMATION_MS);
    },
    [rowHeight, prefersReducedMotion, flushSnap, rest],
  );

  // Programmatic slide animation for button/keyboard navigation
  const triggerSlideAnimation = useCallback(
    (rowsDelta: number) => {
      if (rowHeight <= 0 || isAnimating || isScrolling) return;
      if (prefersReducedMotion) return;

      const startOffset = rowsDelta * rowHeight;
      setSlideOffset(startOffset);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsAnimating(true);
          setSlideOffset(0);
          setTimeout(() => {
            setIsAnimating(false);
          }, SNAP_ANIMATION_MS);
        });
      });
    },
    [rowHeight, isAnimating, isScrolling, prefersReducedMotion],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /** The gesture is over once the wheel has been quiet, momentum included */
    const waitForQuiet = () => {
      if (restTimer.current) clearTimeout(restTimer.current);
      restTimer.current = setTimeout(() => {
        restTimer.current = null;
        const gesture = flick.current;
        flick.current = restingFlick;
        snapAndNavigate(releaseFlick(gesture, rowHeight));
      }, SCROLL_END_DEBOUNCE_MS);
    };

    const handleWheel = (e: WheelEvent) => {
      if (disabled || rowHeight <= 0) return;

      // This grid pages downwards, so it reads the wheel the other way round:
      // its own axis is the vertical one, and a sideways scroll is not for it.
      // Spelled out field by field: a WheelEvent's deltas live on its
      // prototype, so spreading one copies none of them.
      const wheel = {
        deltaX: e.deltaY,
        deltaY: e.deltaX,
        deltaMode: e.deltaMode,
        // Shift turns a wheel sideways, which is the week grid's axis, not this one
        shiftKey: false,
      };
      const delta = horizontalWheelDelta(
        wheel,
        flickLimit(rowHeight, visibleRows),
      );
      if (delta === null) return;

      e.preventDefault();

      // One notch of a mouse wheel: a row of its own, travelled now
      if (isDetentWheel(wheel)) {
        if (restTimer.current) clearTimeout(restTimer.current);
        restTimer.current = null;
        flick.current = restingFlick;
        snapAndNavigate(Math.sign(delta));
        return;
      }

      // A gesture that starts over a snap lets that one land first
      if (pendingSnap.current) flushSnap();
      setIsScrolling(true);

      // Whole rows crossed are travelled at once, so the shift stays under one
      const step = advanceFlick(flick.current, -delta, rowHeight);
      flick.current = step.state;
      if (step.travelNow !== 0) onNavigateRef.current(step.travelNow);
      setScrollOffset(step.state.offset);
      waitForQuiet();
    };

    container.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheel);
      if (restTimer.current) clearTimeout(restTimer.current);
      if (snapTimer.current) clearTimeout(snapTimer.current);
      pendingSnap.current = null;
    };
  }, [
    containerRef,
    rowHeight,
    visibleRows,
    disabled,
    snapAndNavigate,
    flushSnap,
  ]);

  return {
    scrollOffset,
    slideOffset,
    isScrolling,
    isAnimating,
    triggerSlideAnimation,
  };
}
