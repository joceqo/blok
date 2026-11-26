import { editorUrl } from './calendar-route';
import type { WorkspaceRef } from './workspace-registry';

export type PageView = 'document' | 'whiteboard';
export type PageTarget = { id: string; view?: PageView };
export type PageLink = PageTarget & { device: boolean; local?: true; origin?: string; workspace?: string };
type PageRoute = PageTarget & { local?: true; workspace?: string };
type WebPageLink = PageRoute & { origin: string };

export function pageView(url: URL): PageView {
  const views = url.searchParams.getAll('view');
  return views.length === 1 && views[0] === 'whiteboard' ? 'whiteboard' : 'document';
}

export function pageUrlForView(from: URL, id: string, view: PageView = 'document'): URL {
  const url = editorUrl(from);
  url.searchParams.set('page', id);
  if (view === 'whiteboard') url.searchParams.set('view', view);
  return url;
}

export function clearPageRoute(url: URL): void {
  url.searchParams.delete('page');
  if (url.searchParams.getAll('view').includes('whiteboard')) url.searchParams.delete('view');
}

function pageTarget(url: URL, id: string): PageTarget {
  const view = pageView(url);
  return view === 'whiteboard' ? {id, view} : {id};
}

const pageId = /^[a-zA-Z0-9_-]{1,128}$/;
const localEndpoint = (url: URL): boolean =>
  url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && !url.username && !url.password;

export function pageRoute(url: URL): PageRoute | undefined {
  if (url.pathname !== '/') return;
  const ids = url.searchParams.getAll('page');
  const spaces = url.searchParams.getAll('workspace');
  if (ids.length !== 1 || !pageId.test(ids[0]) || spaces.length > 1 || (spaces.length && !pageId.test(spaces[0]))) return;
  if (url.searchParams.getAll('local').length > 1) return;
  return {...pageTarget(url, ids[0]), ...(url.searchParams.get('local') === '1' && {local:true as const}), ...(spaces.length && {workspace:spaces[0]})};
}

/** A web link is resolved only against the server and membership selected by the gateway. */
export function webPageLink(url: URL): WebPageLink | undefined {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  const route = pageRoute(url);
  return route && {...route, origin:url.origin};
}

export function parsePageLink(value: string): PageLink | undefined {
  if (value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return;
    if (localEndpoint(url) && url.pathname === '/') {
      const link = webPageLink(url);
      return link && !link.local ? {...link, device:true} : undefined;
    }
    if (url.protocol !== 'blok:' || url.host !== 'page') return;
    const workspace = url.searchParams.get('workspace');
    if (workspace !== null && (!pageId.test(workspace) || url.searchParams.getAll('workspace').length !== 1)) return;
    const id = url.pathname.slice(1);
    if (!pageId.test(id)) return;
    const local = url.searchParams.get('local') === '1';
    if (url.searchParams.getAll('local').length > 1 || (local && (!workspace || url.searchParams.has('device') || url.searchParams.has('origin')))) return;
    const origin = url.searchParams.get('origin');
    if (origin && (!localEndpoint(new URL(origin)) || new URL(origin).origin !== origin)) return;
    return {...pageTarget(url, id), device:!!origin || url.searchParams.get('device') === '1', ...(local && {local:true as const}), ...(origin && {origin}), ...(workspace && {workspace})};
  } catch { return; }
}

export function resolveWorkspacePageLink(ref: WorkspaceRef, value: string): PageTarget | undefined {
  try {
    const url = new URL(value);
    if (ref.kind === 'local' && url.origin === location.origin && url.searchParams.get('local') === '1') {
      const link = webPageLink(url);
      return link && (!link.workspace || link.workspace === ref.id) ? link : undefined;
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && ref.kind === 'remote') {
      if (ref.device) {
        const link = parsePageLink(value);
        return link?.origin === ref.server && (!link.workspace || link.workspace === ref.id) ? link : undefined;
      }
      const link = webPageLink(url);
      return link && !link.local && link.origin === ref.server && (!link.workspace || link.workspace === ref.id) ? link : undefined;
    }
    const link = parsePageLink(value);
    if (!link) return;
    if (link.local && ref.kind !== 'local') return;
    if (link.workspace && link.workspace !== ref.id) return;
    if (link.device && (ref.kind !== 'remote' || !ref.device || (link.origin && link.origin !== ref.server))) return;
    return link;
  } catch { return; }
}

export function pageIdForWorkspaceLink(ref: WorkspaceRef, value: string): string | undefined {
  return resolveWorkspacePageLink(ref, value)?.id;
}

export function nativePageLink(id: string, view: PageView = 'document', diskWorkspace?: string): string {
  const url = new URL('blok://page/' + encodeURIComponent(id));
  if (diskWorkspace) {
    url.searchParams.set('local', '1');
    url.searchParams.set('workspace', diskWorkspace);
  }
  if (view === 'whiteboard') url.searchParams.set('view', view);
  return url.href;
}

export function workspacePageLink(ref: WorkspaceRef, id: string, view: PageView = 'document'): string {
  if (ref.kind === 'local' && '__TAURI_INTERNALS__' in window) return nativePageLink(id, view, ref.id);
  const url = new URL('/', ref.kind === 'remote' ? ref.server : location.href);
  url.searchParams.set('page', id);
  if (ref.kind === 'local') url.searchParams.set('local', '1');
  url.searchParams.set('workspace', ref.id);
  if (view === 'whiteboard') url.searchParams.set('view', view);
  return url.href;
}
