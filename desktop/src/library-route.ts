const views = ['recents', 'favorites', 'private', 'shared'] as const;
export type LibraryView = typeof views[number];

export function isTeamspaceLibrary(url: URL): boolean {
  return url.pathname.replace(/\/$/, '') === '/library/teamspaces';
}

export function libraryView(url: URL): LibraryView | undefined {
  if (isTeamspaceLibrary(url)) return 'recents';
  const path = url.pathname.replace(/\/$/, '');
  return views.find(view => path === '/library/' + view);
}

export function libraryPageId(url: URL): string | null {
  return libraryView(url) && url.searchParams.get('pm') === 's' ? url.searchParams.get('p') || null : null;
}

export function libraryPageUrl(from: URL, pageId: string | null): URL {
  const url = new URL(from);
  url.searchParams.delete('pvs');
  if (pageId) {
    url.searchParams.set('p', pageId);
    url.searchParams.set('pm', 's');
  } else {
    url.searchParams.delete('p');
    url.searchParams.delete('pm');
  }
  return url;
}

export function libraryUrl(from: URL, view: LibraryView | 'teamspaces'): URL {
  const url = libraryPageUrl(from, null);
  url.pathname = '/library/' + view;
  url.searchParams.delete('page');
  url.searchParams.delete('view');
  url.hash = '';
  return url;
}
