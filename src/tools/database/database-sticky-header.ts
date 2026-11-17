/**
 * A horizontal scrollport also becomes a vertical scroll container in CSS.
 * Its header therefore cannot stick to the page with CSS alone. Compensate
 * only for page scroll on the vertical axis. Keep it inside the scrollport so
 * horizontal movement and frozen columns stay native and in sync with rows.
 */
export class DatabaseStickyHeader {
  private frame = 0;
  private pinned = false;
  private destroyed = false;
  private readonly observer: ResizeObserver | null;

  constructor(
    private readonly scroller: HTMLElement,
    private readonly grid: HTMLElement,
    private readonly header: HTMLElement,
  ) {
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule());
    this.observer?.observe(scroller);
    document.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.schedule);
    this.schedule();
  }

  private readonly onScroll = (event: Event): void => {
    const target = event.target;

    if (target === this.scroller) return;
    if (target === document
      || (target instanceof Element && target.contains(this.scroller))) this.schedule();
  };

  private readonly schedule = (): void => {
    if (this.destroyed || this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  };

  private pageEdge(): number {
    let ancestor: HTMLElement | null = this.scroller.parentElement;

    while (ancestor !== null) {
      const overflow = getComputedStyle(ancestor).overflowY;

      if (overflow === 'auto' || overflow === 'scroll') {
        const toolbar = ancestor.querySelector<HTMLElement>(':scope > [data-desktop-page-toolbar]');

        return toolbar?.getBoundingClientRect().bottom ?? ancestor.getBoundingClientRect().top;
      }
      ancestor = ancestor.parentElement;
    }

    return 0;
  }

  private update(): void {
    if (this.destroyed || !this.scroller.isConnected) return;
    const port = this.scroller.getBoundingClientRect();
    // Cached row editors remain connected under a hidden host. They must not
    // walk ancestors and recalculate sticky geometry on every page scroll.
    if (port.width === 0 || port.height === 0) {
      this.unpin();

      return;
    }
    const grid = this.grid.getBoundingClientRect();
    const top = this.pageEdge();
    const shouldPin = grid.top < top && port.bottom > top
      && port.right > 0 && port.left < window.innerWidth;

    if (!shouldPin) {
      this.unpin();

      return;
    }
    if (!this.pinned) {
      this.header.setAttribute('data-blok-database-header-pinned', '');
      this.pinned = true;
    }
    const offset = Math.max(0, Math.min(top - grid.top, grid.height - this.header.offsetHeight));

    this.header.style.transform = `translateY(${offset}px)`;
  }

  private unpin(): void {
    if (!this.pinned) return;
    this.header.removeAttribute('data-blok-database-header-pinned');
    this.header.style.removeProperty('transform');
    this.pinned = false;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    document.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.schedule);
    this.unpin();
  }
}
