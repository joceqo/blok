import type { WorkspaceRef } from './workspace-registry';

export type PageLink = { id: string; device: boolean; origin?: string; workspace?: string };
const pageId = /^[a-zA-Z0-9_-]{1,128}$/;
const localEndpoint = (url: URL): boolean =>
  url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && !url.username && !url.password;

export function parsePageLink(value: string): PageLink | undefined {
  if (value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return;
    const workspace = url.searchParams.get('workspace');
    if (workspace !== null && (!pageId.test(workspace) || url.searchParams.getAll('workspace').length !== 1)) return;
    if (localEndpoint(url) && url.pathname === '/') {
      const id = url.searchParams.get('page');
      return id && pageId.test(id) && url.searchParams.getAll('page').length === 1
        ? {id, device:true, origin:url.origin, ...(workspace && {workspace})} : undefined;
    }
    if (url.protocol !== 'blok:' || url.host !== 'page') return;
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
      const id = url.searchParams.get('page');
      if (url.origin === ref.server && url.pathname === '/' && !url.username && !url.password && id && pageId.test(id)) return id;
      return;
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
  if (ref.kind === 'remote' && ref.device) url.searchParams.set('workspace', ref.id);
  return url.href;
}
