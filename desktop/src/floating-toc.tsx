import { createRoot } from 'react-dom/client';
import type { CSSProperties, MouseEvent } from 'react';
import {shellText} from './shell-i18n';
import { outlineDepths } from '../../src/shared/outline-depths';

interface Heading {
  id: string;
  level: number;
  text: string;
  element: HTMLElement;
}

/** Notion's floating outline follows the heading nearest the scroller's upper quarter. */
export function closestTocHeading(
  rects: readonly { id: string; top: number; height: number }[],
  targetY: number,
): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const rect of rects) {
    const distance = Math.abs(targetY - (rect.top + rect.height / 2));
    if (best === null || distance < best.distance) best = { id: rect.id, distance };
  }
  return best?.id ?? null;
}

/** The live DOM gives reading order and the expanded state of nested headings. */
export function collectFloatingHeadings(redactor: Element): Heading[] {
  return Array.from(redactor.querySelectorAll<HTMLElement>('[data-blok-tool="header"]')).flatMap((element) => {
    const holder = element.closest<HTMLElement>('[data-blok-element]');
    const id = holder?.getAttribute('data-blok-id') ?? '';
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!holder || !id || !text || !redactor.contains(holder) ||
      element.closest('[hidden], [aria-hidden="true"], .hidden') || element.getClientRects().length === 0) return [];
    const rawLevel = Number.parseInt(element.getAttribute('data-blok-heading-level') ?? '', 10);
    const level = Number.isFinite(rawLevel) ? Math.max(1, Math.min(6, rawLevel)) : 1;
    return [{ id, level, text, element }];
  });
}

export interface FloatingToc {
  element: HTMLElement;
  destroy(): void;
}

interface OutlineProps {
  headings: Heading[];
  activeId: string | null;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, heading: Heading) => void;
}

const PageOutline = ({ headings, activeId, onNavigate }: OutlineProps) => {
  const depths = outlineDepths(headings.map(heading => heading.level));
  return (
    <ol role="list">
      {headings.map((heading, index) => (
        <li key={heading.id} style={{ '--toc-depth': depths[index] } as CSSProperties}>
          <a href={`#${encodeURIComponent(heading.id)}`} data-desktop-floating-toc-link={heading.id} aria-label={heading.text}
             aria-current={activeId === heading.id ? 'location' : undefined}
             onClick={event => onNavigate(event, heading)}>
            <span data-desktop-floating-toc-line="" aria-hidden="true" />
            <span data-desktop-floating-toc-label="">{heading.text}</span>
          </a>
        </li>
      ))}
    </ol>
  );
};

export function createFloatingToc(scroller: HTMLElement, redactor: HTMLElement): FloatingToc {
  const article = redactor.closest<HTMLElement>('[data-desktop-document]') ?? redactor;
  const toolbar = scroller.querySelector<HTMLElement>('[data-desktop-page-toolbar]');
  const nav = document.createElement('nav');
  nav.setAttribute('data-desktop-floating-toc', '');
  nav.setAttribute('aria-label', shellText('Sommaire de la page'));
  scroller.append(nav);
  const root = createRoot(nav);
  let headings: Heading[] = [];
  let activeId: string | null = null;
  let frame: number | null = null;
  let outlineChanged = true;

  function navigate(event: MouseEvent<HTMLAnchorElement>, heading: Heading) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    scroller.scrollTo({
      top: scroller.scrollTop + heading.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (toolbar?.offsetHeight ?? 0) - 20,
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }

  function refresh() {
    frame = null;
    const viewport = scroller.getBoundingClientRect();
    // The article starts immediately below the cover, including when a cover is added mid-edit.
    const top = Math.max(article.getBoundingClientRect().top + 24, viewport.top + (toolbar?.offsetHeight ?? 0) + 24);
    const height = viewport.bottom - top - 16;
    const railRight = Math.min(viewport.right - 12, redactor.getBoundingClientRect().right + 48);
    const dirty = outlineChanged;
    if (dirty) {
      headings = collectFloatingHeadings(redactor);
      outlineChanged = false;
    }
    nav.hidden = !headings.length || viewport.width < 900 || height < 64;
    nav.style.top = `${top}px`;
    nav.style.right = `${window.innerWidth - railRight}px`;
    nav.style.maxHeight = `${Math.max(0, height)}px`;
    nav.style.setProperty('--toc-room-right', `${viewport.right - 12 - railRight}px`);
    const next = nav.hidden ? null : closestTocHeading(headings.map(({id, element}) => {
      const {top, height} = element.getBoundingClientRect();
      return {id, top, height};
    }), viewport.top + viewport.height * 0.25);
    if (dirty || activeId !== next) {
      activeId = next;
      root.render(<PageOutline headings={headings} activeId={activeId} onNavigate={navigate} />);
    }
  }
  function schedule() {
    if (frame === null) frame = window.requestAnimationFrame(refresh);
  }
  function invalidate() {
    outlineChanged = true;
    schedule();
  }
  const observer = new MutationObserver(invalidate);
  observer.observe(redactor, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'aria-hidden', 'data-blok-heading-level', 'data-blok-toggle-open', 'data-blok-id'] });
  observer.observe(scroller, { childList: true });
  const resize = new ResizeObserver(invalidate);
  resize.observe(scroller);
  resize.observe(redactor);
  resize.observe(article);
  if (toolbar) resize.observe(toolbar);
  scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  refresh();

  return {
    element: nav,
    destroy() {
      observer.disconnect();
      resize.disconnect();
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
      root.unmount();
      nav.remove();
    },
  };
}
