/** Local troubleshooting for intermittent peek dismissal. No page/row IDs or field values. */
export const mountPeekDiagnostics = (): (() => void) => {
  const key = 'blok:peek-dismissals';
  let history: unknown[] = [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(saved)) history = saved.slice(-20);
  } catch { /* Diagnostics must work without persistent storage too. */ }
  Reflect.set(window, '__blokPeekDismissals', history);
  let lastPress: { at: number; surface: string; inside: boolean; target: Node | null } | undefined;
  const pointer = (event: Event): void => {
    const path = event.composedPath().filter((node): node is Element => node instanceof Element);
    const surfaces = [
      ['property', '[data-blok-database-drawer-prop-value], [data-blok-database-cell-editor]'],
      ['body', '[data-blok-database-drawer-editor]'],
      ['step', '[data-blok-database-peek-prev], [data-blok-database-peek-next]'],
      ['title', '[data-blok-database-drawer-title]'],
      ['popover', '[data-blok-popover], [data-blok-popover-opened]'],
      ['backdrop', '[data-blok-database-peek-backdrop]'],
    ];
    lastPress = {
      at: performance.now(),
      surface: surfaces.find(([, selector]) => path.some(node => node.matches(selector)))?.[0] ?? 'other',
      inside: path.some(node => node.matches('[data-blok-database-drawer]')),
      target: event.target instanceof Node ? event.target : null,
    };
  };
  const closed = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as { reason?: string; mode?: string; stack?: string } | null;
    if (!detail || typeof detail.reason !== 'string' || typeof detail.mode !== 'string') return;
    const press = lastPress;
    history.push({
      at: new Date().toISOString(), reason: detail.reason, mode: detail.mode,
      stack: typeof detail.stack === 'string' ? detail.stack.replace(/\?[^\s)]+/g, '').slice(0, 1500) : undefined,
      press: press ? {surface:press.surface,inside:press.inside,connected:press.target?.isConnected ?? false,ageMs:Math.round(performance.now()-press.at)} : undefined,
    });
    if (history.length > 20) history.splice(0, history.length - 20);
    try { localStorage.setItem(key, JSON.stringify(history)); } catch { /* Keep the in-memory copy. */ }
  };
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('blok:peek-close', closed);
  return () => {
    document.removeEventListener('pointerdown', pointer, true);
    document.removeEventListener('blok:peek-close', closed);
    lastPress = undefined;
  };
};
