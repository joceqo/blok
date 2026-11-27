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

  it('tracks the document below the cover and keeps the rail beside the text on scroll', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const scroller = document.createElement('main');
    const article = document.createElement('article');
    const redactor = document.createElement('div');
    article.dataset.desktopDocument = '';
    redactor.innerHTML = '<div data-blok-element data-blok-id="intro"><h2 data-blok-tool="header">Intro</h2></div>';
    const heading = redactor.querySelector('h2')!;
    heading.getClientRects = () => ({length: 1}) as DOMRectList;
    let articleTop = 280;
    scroller.getBoundingClientRect = () => new DOMRect(20, 40, 1200, 760);
    redactor.getBoundingClientRect = () => new DOMRect(140, articleTop + 60, 860, 1500);
    article.getBoundingClientRect = () => new DOMRect(80, articleTop, 980, 1700);
    article.append(redactor);
    scroller.append(article);
    document.body.append(scroller);
    const toc = createFloatingToc(scroller, redactor);
    try {
      expect(toc.element.hidden).toBe(false);
      expect(toc.element.style.top).toBe('304px');
      expect(window.innerWidth - parseFloat(toc.element.style.right)).toBe(1048);
      articleTop = 190;
      scroller.dispatchEvent(new Event('scroll'));
      await vi.waitFor(() => expect(toc.element.style.top).toBe('214px'));
      articleTop = -200;
      scroller.dispatchEvent(new Event('scroll'));
      await vi.waitFor(() => expect(toc.element.style.top).toBe('64px'));
    } finally {
      toc.destroy();
      scroller.remove();
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
