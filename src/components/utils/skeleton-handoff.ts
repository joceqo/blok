export const HANDOFF_STAGGER = 0;
export const HANDOFF_DURATION = 150;
export const REDUCED_FADE = HANDOFF_DURATION;

// A cancelled animation rejects `finished`; cleanup must still run.
const settle = (animation: Animation): Promise<unknown> => animation.finished.catch(() => undefined);

/** Fade each loading region in place. Chunk arrivals do not provide stable bar-to-block geometry. */
export const runSkeletonHandoff = async ({ bars, content, companions = [] }: {
  bars: HTMLElement[];
  targets: HTMLElement[];
  content: HTMLElement;
  companions?: HTMLElement[];
}): Promise<void> => {
  if (typeof content.animate !== 'function') return;

  // Capture the breathing opacity before replacing the CSS animation, without
  // reading any content geometry or shifting bars toward unrelated blocks.
  const opacities = bars.map(bar => Number.parseFloat(getComputedStyle(bar).opacity));
  const options: KeyframeAnimationOptions = {duration: HANDOFF_DURATION, easing: 'ease-out', fill: 'both'};

  await Promise.all([
    ...bars.map((bar, index) => settle(bar.animate([
      {opacity: Number.isFinite(opacities[index]) ? opacities[index] : 1},
      {opacity: 0},
    ], options))),
    ...[content, ...companions].map(element => settle(element.animate([
      {opacity: 0}, {opacity: 1},
    ], options))),
  ]);
};
