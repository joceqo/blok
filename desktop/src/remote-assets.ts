/** Resolve private media for rendering while tools retain their canonical data URLs. */
export function mountRemoteAssets(server: string, resolve: (url: string) => Promise<string>): () => void {
  const originalFetch = window.fetch;
  let alive = true;
  const canonical = new WeakMap<Element, Map<string, {original: string; resolved: string}>>();
  const pending = new WeakMap<Element, Set<string>>();
  const serverOrigin = new URL(server).origin;
  // Share the exact URL so the browser can reuse a table icon in its peek.
  // Keep grants briefly in memory only, scoped to this workspace mount.
  const signatures = new Map<string, { promise: Promise<string>; until: number; url?: string }>();
  function signedUrl(asset: string): Promise<string> {
    const cached = signatures.get(asset);
    if (cached && cached.until > Date.now()) return cached.promise;
    const entry = { promise: Promise.resolve(''), until: Infinity, url: undefined as string | undefined };
    entry.promise = resolve(asset).then(url => {
      const expires = Number(new URL(url, serverOrigin).searchParams.get('expires')) * 1000;
      entry.until = Math.min(Date.now() + 45_000, expires > 0 ? expires - 5_000 : Infinity);
      entry.url = url;
      return url;
    }).catch(error => {
      if (signatures.get(asset) === entry) signatures.delete(asset);
      throw error;
    });
    signatures.delete(asset);
    signatures.set(asset, entry);
    if (signatures.size > 256) signatures.delete(signatures.keys().next().value!);
    return entry.promise;
  }
  function revealImage(element: Element): void {
    if (!(element instanceof HTMLImageElement) || element.naturalWidth === 0) return;
    const entry = canonical.get(element)?.get('src');
    if (entry?.resolved === element.getAttribute('src')) element.removeAttribute('data-desktop-asset-loading');
  }
  const loaded = (event: Event): void => {
    if (event.target instanceof Element) revealImage(event.target);
  };
  const privateUrl = (raw: string): string | null => {
    try {
      // Stored icons/avatars may be root-relative. In Tauri, location is the
      // bundled application, not the server that owns the workspace's files.
      const url = new URL(raw, serverOrigin);
      return url.origin === serverOrigin && !url.username && !url.password && url.pathname.startsWith('/files/') && !url.searchParams.has('grant') ? url.href : null;
    } catch { return null; }
  };
  // Binary previews and downloads fetch canonical URLs, unlike media elements.
  const fetchWithPrivateAssets: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const asset = privateUrl(url);
    if (!asset) return originalFetch.call(window, input, init);
    const signed = await signedUrl(asset);
    return originalFetch.call(window, input instanceof Request ? new Request(signed, input) : signed, init);
  };
  window.fetch = fetchWithPrivateAssets;
  async function refresh(element: Element, attribute: string): Promise<void> {
    const raw = element.getAttribute(attribute);
    const asset = raw && privateUrl(raw);
    if (!raw || !asset) return;
    const inFlight = pending.get(element) ?? new Set<string>();
    if (inFlight.has(attribute)) return;
    pending.set(element, inFlight); inFlight.add(attribute);
    if (element instanceof HTMLImageElement) element.setAttribute('data-desktop-asset-loading', '');
    try {
      const resolved = await signedUrl(asset);
      if (!alive || element.getAttribute(attribute) !== raw) return;
      const entries = canonical.get(element) ?? new Map();
      entries.set(attribute, {original: raw, resolved}); canonical.set(element, entries);
      element.setAttribute(attribute, resolved);
      if (element instanceof HTMLImageElement && element.complete) revealImage(element);
    } catch { /* Preserve canonical src; retry on the next render or media error. */ }
    finally {
      inFlight.delete(attribute);
      // A renderer may reuse an img while the first signature is in flight.
      // Its mutation was skipped above; resolve the latest source now.
      if (alive && element.getAttribute(attribute) !== raw) void refresh(element, attribute);
    }
  }
  function scan(element: Element): void {
    for (const node of [element, ...element.querySelectorAll('img,video,audio,source,a[href]')]) {
      // A reused element can also switch from a private to an external image.
      const src = node.getAttribute('src');
      if (src && !privateUrl(src) && canonical.get(node)?.get('src')?.resolved !== src) node.removeAttribute('data-desktop-asset-loading');
      if (node.matches('img,video,audio,source')) void refresh(node, 'src');
      if (node.matches('video')) void refresh(node, 'poster');
      if (node.matches('a[href]')) void refresh(node, 'href');
    }
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') scan(record.target as Element);
      else for (const node of record.addedNodes) if (node instanceof Element) scan(node);
    }
  });
  observer.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter:['src','poster','href']});
  const lastRetry = new WeakMap<Element, number>();
  const retry = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const element = event.target;
    if (Date.now() - (lastRetry.get(element) ?? 0) < 30_000) return;
    const entries = canonical.get(element);
    if (!entries) return;
    for (const [attr, entry] of entries) if (element.getAttribute(attr) === entry.resolved) {
      lastRetry.set(element, Date.now());
      const asset = privateUrl(entry.original);
      if (asset && signatures.get(asset)?.url === entry.resolved) signatures.delete(asset);
      element.setAttribute(attr, entry.original);
      void refresh(element, attr);
    }
  };
  const opening = new WeakSet<HTMLAnchorElement>();
  const openLink = (event: MouseEvent): void => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || opening.has(anchor)) return;
    const known = canonical.get(anchor)?.get('href');
    const original = privateUrl(anchor.getAttribute('href') ?? '') ?? (known && known.resolved === anchor.href ? privateUrl(known.original) : null);
    if (!original) return;
    event.preventDefault();
    const before = anchor.href;
    void signedUrl(original).then((signed) => {
      if (!alive || anchor.href !== before) return;
      const entries = canonical.get(anchor) ?? new Map();
      entries.set('href', {original, resolved: signed}); canonical.set(anchor, entries);
      anchor.href = signed;
      opening.add(anchor);
      try { anchor.click(); } finally { opening.delete(anchor); }
    }).catch(() => undefined);
  };
  document.addEventListener('click', openLink, true);
  document.addEventListener('error', retry, true);
  document.addEventListener('load', loaded, true);
  scan(document.body);
  return () => {
    alive = false;
    observer.disconnect();
    signatures.clear();
    document.removeEventListener('load', loaded, true);
    document.removeEventListener('error', retry, true);
    document.removeEventListener('click', openLink, true);
    document.querySelectorAll('[data-desktop-asset-loading]').forEach(node => node.removeAttribute('data-desktop-asset-loading'));
    if (window.fetch === fetchWithPrivateAssets) window.fetch = originalFetch;
  };
}
