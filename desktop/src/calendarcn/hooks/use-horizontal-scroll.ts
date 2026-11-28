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

interface UseHorizontalScrollOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  dayColumnWidth: number;
  /** Day columns on screen */
  visibleDays: number;
  /**
   * Columns the view moves in one step. A week view that re-anchors on the
   * first day of the week moves by whole weeks: stepping a single day there
   * is pulled straight back to the same Monday, or past it.
   */
  navStep?: number;
  onNavigate: (daysDelta: number) => void;
  disabled?: boolean;
}

interface UseHorizontalScrollReturn {
  scrollOffset: number;
  slideOffset: number;
  isScrolling: boolean;
  isAnimating: boolean;
  triggerSlideAnimation: (daysDelta: number) => void;
}

/** A gesture has ended once the wheel has been quiet for this long */
const SCROLL_END_DEBOUNCE_MS = 150;
const SNAP_ANIMATION_MS = 200;

export function useHorizontalScroll({
  containerRef,
  dayColumnWidth,
  visibleDays,
  navStep = 1,
  onNavigate,
  disabled,
}: UseHorizontalScrollOptions): UseHorizontalScrollReturn {
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
   * momentum, and taking that for a new gesture would travel a second time.
   * Only silence ends a gesture, in the timer below.
   */
  const rest = useCallback(() => {
    setScrollOffset(0);
    setIsAnimating(false);
    setIsScrolling(false);
  }, []);

  /** Slides to the column the gesture landed on, then moves the calendar there */
  const snapAndNavigate = useCallback(
    (daysDelta: number) => {
      if (dayColumnWidth <= 0) return;
      flushSnap();

      if (daysDelta === 0) {
        // Short of half a column: back to where the gesture started
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
        onNavigateRef.current(daysDelta);
        rest();
        return;
      }

      // The grid shifts against the direction of travel
      setIsAnimating(true);
      setScrollOffset(-daysDelta * dayColumnWidth);
      pendingSnap.current = () => {
        onNavigateRef.current(daysDelta);
        rest();
      };
      snapTimer.current = setTimeout(flushSnap, SNAP_ANIMATION_MS);
    },
    [dayColumnWidth, prefersReducedMotion, flushSnap, rest],
  );

  // Programmatic slide animation for button/keyboard navigation
  // Uses slideOffset (not scrollOffset) so dynamicBuffer isn't affected
  // Does NOT call onNavigate — caller is responsible for having already changed the date
  const triggerSlideAnimation = useCallback(
    (daysDelta: number) => {
      if (dayColumnWidth <= 0 || isAnimating || isScrolling) return;
      if (prefersReducedMotion) return;

      // Start from the opposite direction to create slide effect
      const startOffset = daysDelta * dayColumnWidth;
      setSlideOffset(startOffset);

      // Force a reflow then animate to 0
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
    [dayColumnWidth, isAnimating, isScrolling, prefersReducedMotion],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /** Columns one navigation step covers */
    const stride = Math.max(1, navStep);

    /** The gesture is over once the wheel has been quiet, momentum included */
    const waitForQuiet = () => {
      if (restTimer.current) clearTimeout(restTimer.current);
      restTimer.current = setTimeout(() => {
        restTimer.current = null;
        const gesture = flick.current;
        flick.current = restingFlick;
        snapAndNavigate(releaseFlick(gesture, dayColumnWidth * stride) * stride);
      }, SCROLL_END_DEBOUNCE_MS);
    };

    const handleWheel = (e: WheelEvent) => {
      if (disabled || dayColumnWidth <= 0) return;

      const delta = horizontalWheelDelta(
        e,
        flickLimit(dayColumnWidth, visibleDays),
      );
      // A vertical scroll belongs to the hours
      if (delta === null) return;

      e.preventDefault();

      // One notch of a mouse wheel: a day of its own, travelled now. Notches
      // come far apart, so a gesture made of them would end between any two.
      if (isDetentWheel(e)) {
        if (restTimer.current) clearTimeout(restTimer.current);
        restTimer.current = null;
        flick.current = restingFlick;
        snapAndNavigate(Math.sign(delta) * stride);
        return;
      }

      // A gesture that starts over a snap lets that one land first
      if (pendingSnap.current) flushSnap();
      setIsScrolling(true);

      // The grid follows the fingers, pixel for pixel. Whole columns it
      // crosses are travelled at once, so the shift it holds stays under one
      // and the gesture goes as far as it is pushed without ever drawing
      // further than the buffer.
      const step = advanceFlick(flick.current, -delta, dayColumnWidth * stride);
      flick.current = step.state;
      if (step.travelNow !== 0) onNavigateRef.current(step.travelNow * stride);
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
    dayColumnWidth,
    visibleDays,
    navStep,
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
