import { libraryPageUrl, libraryView } from './library-route';

/** The query route was used by earlier builds and can still occur in saved tabs. */
export function isCalendarUrl(url: URL): boolean {
  return url.pathname === '/calendar' || url.pathname === '/calendar/' || url.searchParams.get('view') === 'calendar';
}

export function calendarUrl(from: URL): URL {
  const url = libraryView(from) ? libraryPageUrl(from, null) : new URL(from);
  url.pathname = '/calendar';
  url.searchParams.delete('page');
  url.searchParams.delete('view');
  url.hash = '';
  return url;
}

export function editorUrl(from: URL): URL {
  const url = libraryView(from) ? libraryPageUrl(from, null) : new URL(from);
  if (isCalendarUrl(url) || libraryView(url)) url.pathname = '/';
  url.searchParams.delete('view');
  return url;
}
