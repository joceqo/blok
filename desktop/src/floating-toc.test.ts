<<<<<<< HEAD
<<<<<<< HEAD
import { describe, expect, it, vi } from 'vitest';
import { closestTocHeading, collectFloatingHeadings, createFloatingToc } from './floating-toc';

describe('floating table of contents', () => {
  it('keeps the outline inside the page that owns the cover controls', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const page = document.createElement('main');
    const editor = document.createElement('article');
    page.append(editor);
    document.body.append(page);
    const toc = createFloatingToc(page, editor);
    try {
      expect(page.contains(toc.element)).toBe(true);
      page.remove();
      expect(toc.element.isConnected).toBe(false);
    } finally {
      toc.destroy();
      page.remove();
      vi.unstubAllGlobals();
    }
  });

  it('chooses the heading whose centre is nearest the upper quarter', () => {
    const headings = [
      { id: 'first', top: 80, height: 30 },
      { id: 'second', top: 210, height: 30 },
      { id: 'third', top: 430, height: 30 },
    ];
    expect(closestTocHeading(headings, 200)).toBe('second');
    expect(closestTocHeading(headings, 380)).toBe('third');
    expect(closestTocHeading([], 200)).toBeNull();
  });

  it('omits a heading inside a folded parent and restores it when expanded', () => {
    const redactor = document.createElement('div');
    const parent = document.createElement('div');
    const holder = document.createElement('div');
    const heading = document.createElement('h2');
    holder.setAttribute('data-blok-element', '');
    holder.setAttribute('data-blok-id', 'nested-heading');
    heading.setAttribute('data-blok-tool', 'header');
    heading.setAttribute('data-blok-heading-level', '2');
    heading.textContent = 'Nested heading';
    heading.getClientRects = () => ({ length: 1 }) as DOMRectList;
    holder.append(heading);
    parent.append(holder);
    redactor.append(parent);

    parent.classList.add('hidden');
    expect(collectFloatingHeadings(redactor)).toEqual([]);
    parent.classList.remove('hidden');
    expect(collectFloatingHeadings(redactor).map(({ id, text, level }) => ({ id, text, level })))
      .toEqual([{ id: 'nested-heading', text: 'Nested heading', level: 2 }]);
  });
});
||||||| f8ef3c6b39
=======
import { describe, expect, it } from 'vitest';
import { closestTocHeading, collectFloatingHeadings } from './floating-toc';

describe('floating table of contents', () => {
  it('chooses the heading whose centre is nearest the upper quarter', () => {
    const headings = [
      { id: 'first', top: 80, height: 30 },
      { id: 'second', top: 210, height: 30 },
      { id: 'third', top: 430, height: 30 },
    ];
    expect(closestTocHeading(headings, 200)).toBe('second');
    expect(closestTocHeading(headings, 380)).toBe('third');
    expect(closestTocHeading([], 200)).toBeNull();
  });

  it('omits a heading inside a folded parent and restores it when expanded', () => {
    const redactor = document.createElement('div');
    const parent = document.createElement('div');
    const holder = document.createElement('div');
    const heading = document.createElement('h2');
    holder.setAttribute('data-blok-element', '');
    holder.setAttribute('data-blok-id', 'nested-heading');
    heading.setAttribute('data-blok-tool', 'header');
    heading.setAttribute('data-blok-heading-level', '2');
    heading.textContent = 'Nested heading';
    heading.getClientRects = () => ({ length: 1 }) as DOMRectList;
    holder.append(heading);
    parent.append(holder);
    redactor.append(parent);

    parent.classList.add('hidden');
    expect(collectFloatingHeadings(redactor)).toEqual([]);
    parent.classList.remove('hidden');
    expect(collectFloatingHeadings(redactor).map(({ id, text, level }) => ({ id, text, level })))
      .toEqual([{ id: 'nested-heading', text: 'Nested heading', level: 2 }]);
  });
});
>>>>>>> origin/fix/self-host-review
||||||| f8ef3c6b39
=======
import { describe, expect, it } from 'vitest';
import { closestTocHeading, collectFloatingHeadings } from './floating-toc';

describe('floating table of contents', () => {
  it('chooses the heading whose centre is nearest the upper quarter', () => {
    const headings = [
      { id: 'first', top: 80, height: 30 },
      { id: 'second', top: 210, height: 30 },
      { id: 'third', top: 430, height: 30 },
    ];
    expect(closestTocHeading(headings, 200)).toBe('second');
    expect(closestTocHeading(headings, 380)).toBe('third');
    expect(closestTocHeading([], 200)).toBeNull();
  });

  it('omits a heading inside a folded parent and restores it when expanded', () => {
    const redactor = document.createElement('div');
    const parent = document.createElement('div');
    const holder = document.createElement('div');
    const heading = document.createElement('h2');
    holder.setAttribute('data-blok-element', '');
    holder.setAttribute('data-blok-id', 'nested-heading');
    heading.setAttribute('data-blok-tool', 'header');
    heading.setAttribute('data-blok-heading-level', '2');
    heading.textContent = 'Nested heading';
    heading.getClientRects = () => ({ length: 1 }) as DOMRectList;
    holder.append(heading);
    parent.append(holder);
    redactor.append(parent);

    parent.classList.add('hidden');
    expect(collectFloatingHeadings(redactor)).toEqual([]);
    parent.classList.remove('hidden');
    expect(collectFloatingHeadings(redactor).map(({ id, text, level }) => ({ id, text, level })))
      .toEqual([{ id: 'nested-heading', text: 'Nested heading', level: 2 }]);
  });
});
>>>>>>> origin/feat/desktop-title-date-mentions
