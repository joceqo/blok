import { pageDestination } from './page-urls';

/** A page reached through the `blok://` scheme the bundle registers with the OS. */
export interface DeepLinkTarget {
  pageId: string;
  /** Origin of the server owning the page; absent for a page held on this device. */
  server?: string;
  workspaceId?: string;
  local: boolean;
}

/** The scheme carries no authority, so the host segment names the resource kind. */
const PAGE_HOST = 'page';

/** Links reach us from the OS and from page content alike: never assume valid. */
function parsed(value: string, base?: string): URL | null {
  try { return new URL(value, base); } catch { return null; }
}

/** A link arrives from outside the app: only a web origin may become a server. */
function webOrigin(value: string | null): string | undefined {
  const url = value ? parsed(value) : null;
  if (!url) return undefined;
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
}

/**
 * Builds the link that opens `href` in the installed application.
 *
 * A page identifier alone is ambiguous once several workspaces exist, so the
 * link carries where to look: the server for a remote page, `local=1` for one
 * held on this device. Without it the app would open the right identifier in
 * the wrong workspace, or nothing at all.
 */
export function deepLinkFor(href: string, context: { workspaceId?: string } = {}): string | null {
  const url = parsed(href, location.href);
  if (!url) return null;
  const destination = pageDestination(url.href);
  if (destination.kind === 'invalid' || destination.kind === 'none') return null;
  const link = new URL(`blok://${PAGE_HOST}/${encodeURIComponent(destination.id)}`);
  const local = url.searchParams.get('local') === '1';
  if (local) link.searchParams.set('local', '1');
  else link.searchParams.set('server', url.origin);
  if (context.workspaceId) link.searchParams.set('workspace', context.workspaceId);
  return link.href;
}

/** Reads a `blok://` link back, dropping anything it cannot vouch for. */
export function deepLinkTarget(link: string): DeepLinkTarget | null {
  const url = parsed(link);
  if (!url || url.protocol !== 'blok:' || url.host !== PAGE_HOST) return null;
  const pageId = decodeURIComponent(url.pathname.replace(/^\//, '')).trim();
  if (!pageId) return null;
  const local = url.searchParams.get('local') === '1';
  const server = local ? undefined : webOrigin(url.searchParams.get('server'));
  // A remote link without a usable server would silently resolve against
  // whichever workspace happens to be open — refuse it instead.
  if (!local && !server) return null;
  const workspaceId = url.searchParams.get('workspace') ?? undefined;
  return {pageId, local, ...(server ? {server} : {}), ...(workspaceId ? {workspaceId} : {})};
}

/**
 * Turns a `blok://` link into the in-app URL that boot already understands:
 * `?page=` drives the destination, `?server=` and `?local=1` the workspace.
 */
export function appUrlForDeepLink(link: string, currentHref: string): string | null {
  const target = deepLinkTarget(link);
  if (!target) return null;
  const url = parsed('/', currentHref);
  if (!url) return null;
  url.searchParams.set('page', target.pageId);
  if (target.local) url.searchParams.set('local', '1');
  else if (target.server) url.searchParams.set('server', target.server);
  return url.href;
}

/** Marks a web URL whose only purpose is to hand the page to the application. */
export const HANDOFF_PARAM = 'open';

/**
 * A `blok://` URL cannot be pasted into an address bar: a browser decides
 * between URL and search term from the scheme alone, and an unknown one becomes
 * a search. So the shareable link stays `https://…?open=app`, a real web URL,
 * and the page it loads performs the hand-off.
 */
export function handoffUrl(href: string): string | null {
  const url = parsed(href, location.href);
  if (!url) return null;
  const link = deepLinkFor(url.href);
  if (!link) return null;
  url.searchParams.set(HANDOFF_PARAM, 'app');
  return url.href;
}

/** The link to follow when a hand-off URL is opened; null when it is not one. */
export function handoffTarget(href: string): string | null {
  const url = parsed(href, location.href);
  if (!url || url.searchParams.get(HANDOFF_PARAM) !== 'app') return null;
  url.searchParams.delete(HANDOFF_PARAM);
  return deepLinkFor(url.href);
}
