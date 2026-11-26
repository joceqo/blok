import { describe, expect, it } from 'vitest';
import { diagramImageUrl, diagramSize } from '../../../../src/tools/code/diagram-image';

const parse = (svg: string): Element =>
  new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;

const decode = (url: string): string => decodeURIComponent(url.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));

describe('diagramSize', () => {
  it('prefers the element own dimensions', () => {
    expect(diagramSize(parse('<svg width="420" height="110" viewBox="0 0 10 10"/>')))
      .toEqual({ width: 420, height: 110 });
  });

  /** How Mermaid actually emits it: a percentage width and the size in viewBox. */
  it('falls back to the viewBox, which is where Mermaid keeps the real size', () => {
    expect(diagramSize(parse('<svg width="100%" viewBox="0 0 243.75 182.5"/>')))
      .toEqual({ width: 243.75, height: 182.5 });
  });

  it('answers null when neither source gives a usable size', () => {
    expect(diagramSize(parse('<svg/>'))).toBeNull();
    expect(diagramSize(parse('<svg viewBox="0 0 10"/>'))).toBeNull();
    expect(diagramSize(parse('<svg width="0" height="0"/>'))).toBeNull();
  });
});

describe('diagramImageUrl', () => {
  it('gives the image an intrinsic size so the lightbox can scale it', () => {
    const svg = decode(String(diagramImageUrl('<svg width="100%" viewBox="0 0 240 180"><rect/></svg>')));
    expect(svg).toContain('width="240"');
    expect(svg).toContain('height="180"');
  });

  /** Left in place, max-width pins the drawing to its document size — zooming
   * would then enlarge the frame around an unchanged picture. */
  it('drops the max-width that would cap the drawing at its inline size', () => {
    const svg = decode(String(diagramImageUrl(
      '<svg width="100%" viewBox="0 0 240 180" style="max-width: 240px; background: white;"><rect/></svg>')));
    expect(svg).not.toContain('max-width');
    expect(svg).toContain('background: white');
  });

  it('keeps the drawing itself untouched', () => {
    const svg = decode(String(diagramImageUrl('<svg viewBox="0 0 10 10"><g id="flow"><path d="M0 0"/></g></svg>')));
    expect(svg).toContain('<g id="flow">');
    expect(svg).toContain('<path d="M0 0"/>');
  });

  it('answers null when the render produced a message instead of a drawing', () => {
    // renderMermaid returns this span for invalid syntax.
    expect(diagramImageUrl('<span class="text-red-500 text-sm">Invalid Mermaid syntax</span>')).toBeNull();
    expect(diagramImageUrl('')).toBeNull();
    expect(diagramImageUrl('pas du balisage')).toBeNull();
  });
});
