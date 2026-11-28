type InspectorWindow = Window & {
  __REACT_GRAB__?: { isActive(): boolean };
};

/** Inspection disables pointer hit testing, so the event can target the page behind a surface. */
export const isInspectorPointer = (target: EventTarget | null): boolean =>
  (window as InspectorWindow).__REACT_GRAB__?.isActive() === true ||
  (target instanceof Element && target.closest('[data-react-grab]') !== null);
