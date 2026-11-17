/**
 * A horizontal scrollport also becomes a vertical scroll container in CSS.
 * Its header therefore cannot stick to the page. Move the real header into
 * the top layer while the table crosses the page's sticky edge; it keeps its
 * DOM identity, grid handlers and popover anchors.
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
    private readonly stickAt: () => number,
  ) {
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule());
    this.observer?.observe(scroller);
    document.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.schedule);
    this.schedule();
  }

  private readonly onScroll = (event: Event): void => {
    const target = event.target;

    if (target === document || target === this.scroller
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
    if (this.destroyed || !this.scroller.isConnected || typeof this.header.showPopover !== 'function') return;
    const port = this.scroller.getBoundingClientRect();
    // Cached row editors remain connected under a hidden host. They must not
    // walk ancestors and recalculate sticky geometry on every page scroll.
    if (port.width === 0 || port.height === 0) {
      this.unpin();

      return;
    }
    const grid = this.grid.getBoundingClientRect();
    const top = this.pageEdge();
    const shouldPin = grid.top < top && port.bottom > top + this.header.offsetHeight
      && port.right > 0 && port.left < window.innerWidth;

    if (!shouldPin) {
      this.unpin();

      return;
    }
    if (!this.pinned) {
      this.header.setAttribute('popover', 'manual');
      this.header.showPopover();
      this.pinned = true;
    }

    const left = Math.max(0, port.left - grid.left);
    const right = Math.max(0, grid.right - port.right);

    this.header.style.top = `${top}px`;
    this.header.style.left = `${grid.left}px`;
    this.header.style.width = `${grid.width}px`;
    this.header.style.clipPath = `inset(0 ${right}px 0 ${left}px)`;
    this.header.style.setProperty('--_blok-database-pinned-shift', `${Math.max(0, Math.abs(this.scroller.scrollLeft) - this.stickAt())}px`);
  }

  private unpin(): void {
    if (!this.pinned) return;
    if (this.header.matches(':popover-open')) this.header.hidePopover();
    this.header.removeAttribute('popover');
    this.header.style.removeProperty('top');
    this.header.style.removeProperty('left');
    this.header.style.removeProperty('width');
    this.header.style.removeProperty('clip-path');
    this.header.style.removeProperty('--_blok-database-pinned-shift');
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
