export const libraryViews = ['teamspaces', 'recents', 'favorites', 'shared', 'private'] as const;
export type LibraryView = typeof libraryViews[number];

export function libraryView(url: URL): LibraryView | undefined {
  const path = url.pathname.replace(/\/$/, '');
  return libraryViews.find(view => path === '/library/' + view);
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

export function libraryUrl(from: URL, view: LibraryView): URL {
  const url = libraryPageUrl(from, null);
  url.pathname = '/library/' + view;
  url.searchParams.delete('page');
  url.searchParams.delete('view');
  url.hash = '';
  return url;
}
