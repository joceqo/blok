import type { WorkspaceRef } from './workspace-registry';

export type PageLink = { id: string; device: boolean; origin?: string; workspace?: string };
type WebPageLink = { id: string; origin: string; workspace?: string };
const pageId = /^[a-zA-Z0-9_-]{1,128}$/;
const localEndpoint = (url: URL): boolean =>
  url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && !url.username && !url.password;

/** A web link is resolved only against the server and membership selected by the gateway. */
export function webPageLink(url: URL): WebPageLink | undefined {
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.username || url.password) return;
  const ids = url.searchParams.getAll('page');
  const spaces = url.searchParams.getAll('workspace');
  if (ids.length !== 1 || !pageId.test(ids[0]) || spaces.length > 1 || (spaces.length && !pageId.test(spaces[0]))) return;
  return {id:ids[0], origin:url.origin, ...(spaces.length && {workspace:spaces[0]})};
}

export function parsePageLink(value: string): PageLink | undefined {
  if (value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return;
    if (localEndpoint(url) && url.pathname === '/') {
      const link = webPageLink(url);
      return link && {...link, device:true};
    }
    if (url.protocol !== 'blok:' || url.host !== 'page') return;
    const workspace = url.searchParams.get('workspace');
    if (workspace !== null && (!pageId.test(workspace) || url.searchParams.getAll('workspace').length !== 1)) return;
    const id = url.pathname.slice(1);
    if (!pageId.test(id)) return;
    const origin = url.searchParams.get('origin');
    if (origin && (!localEndpoint(new URL(origin)) || new URL(origin).origin !== origin)) return;
    return {id, device:!!origin || url.searchParams.get('device') === '1', ...(origin && {origin}), ...(workspace && {workspace})};
  } catch { return; }
}

export function pageIdForWorkspaceLink(ref: WorkspaceRef, value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && ref.kind === 'remote') {
      if (ref.device) {
        const link = parsePageLink(value);
        return link?.origin === ref.server && (!link.workspace || link.workspace === ref.id) ? link.id : undefined;
      }
      const link = webPageLink(url);
      return link && link.origin === ref.server && (!link.workspace || link.workspace === ref.id) ? link.id : undefined;
    }
    const link = parsePageLink(value);
    if (!link) return;
    if (link.device && (ref.kind !== 'remote' || !ref.device || (link.origin && link.origin !== ref.server) || (link.workspace && link.workspace !== ref.id))) return;
    return link.id;
  } catch { return; }
}

export function workspacePageLink(ref: WorkspaceRef, id: string): string {
  const url = new URL('/', ref.kind === 'remote' ? ref.server : location.href);
  url.searchParams.set('page', id);
  if (ref.kind === 'remote') url.searchParams.set('workspace', ref.id);
  return url.href;
}
