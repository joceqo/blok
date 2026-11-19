/** Legacy boot probe for closed database row rendering; it does not defer content. */
const probe = (): Record<string, number> => {
  const host = globalThis as { __blokViewportProbe?: Record<string, number> };

  host.__blokViewportProbe ??= {};

  return host.__blokViewportProbe;
};

/** Counts one diagnostic event without affecting block lifecycle. */
export const countViewport = (key: string): void => {
  const counters = probe();

  counters[key] = (counters[key] ?? 0) + 1;
};
