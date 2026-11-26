/**
 * A rendered diagram, turned into something the image lightbox can show.
 *
 * Mermaid sizes its SVG for the flow of a document: `width="100%"` with the
 * real size parked in a `max-width` style. An `<img>` resolves neither — it
 * would fall back to the 300x150 default replaced-element box and squash the
 * drawing. Restoring the intrinsic size from the viewBox gives the lightbox a
 * ratio to honour, so zoom and pan behave as they do for a photograph.
 */

type Dims = { width: number; height: number };

function parseNumber(raw: string | null): number | null {
  if (raw == null) return null;
  const match = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function fromViewBox(viewBox: string | null): Dims | null {
  if (!viewBox) return null;
  const parts = viewBox.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;
  const width = parseNumber(parts[2]);
  const height = parseNumber(parts[3]);
  return width != null && height != null ? { width, height } : null;
}

/** Intrinsic size of a rendered diagram: its own attributes, else its viewBox. */
export function diagramSize(root: Element): Dims | null {
  const width = parseNumber(root.getAttribute('width'));
  const height = parseNumber(root.getAttribute('height'));
  if (width != null && height != null) return { width, height };
  return fromViewBox(root.getAttribute('viewBox'));
}

/**
 * Encodes a rendered diagram as a data URL, or null when there is nothing to
 * show — a syntax error renders a message, not a drawing.
 */
export function diagramImageUrl(svg: string): string | null {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;
  if (parsed.querySelector('parsererror')) return null;

  const size = diagramSize(root);
  if (size) {
    root.setAttribute('width', String(size.width));
    root.setAttribute('height', String(size.height));
    // The style's max-width caps the drawing at its document width; inside the
    // lightbox that would pin it small whatever the zoom.
    const style = root.getAttribute('style');
    if (style) root.setAttribute('style', style.replace(/max-width\s*:[^;]*;?/gi, '').trim());
  }

  const serialized = new XMLSerializer().serializeToString(root);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
}
