import {describe, expect, it} from 'vitest';
import {calendarUrl, editorUrl} from './calendar-route';
import {isTeamspaceLibrary, libraryPageId, libraryPageUrl, libraryUrl, libraryView} from './library-route';

describe('workspace library links', () => {
  it('preserves the workspace and clears the previous page and its block anchor', () => {
    const from = new URL('https://blok.test/?workspace=atelier&page=a#heading');
    const library = libraryUrl(from, 'favorites');
    expect(library.href).toBe('https://blok.test/library/favorites?workspace=atelier');
    expect(libraryView(library)).toBe('favorites');
    expect(from.hash).toBe('#heading');
    expect(editorUrl(library).pathname).toBe('/');
    expect(calendarUrl(library).pathname).toBe('/calendar');
  });
  it('keeps the teamspace table under an open page and removes peek parameters on exit', () => {
    const link = new URL('https://blok.test/library/teamspaces?workspace=atelier&p=a&pm=s&pvs=140');
    expect(isTeamspaceLibrary(link)).toBe(true);
    expect(libraryView(link)).toBe('recents');
    expect(libraryPageId(link)).toBe('a');
    expect(libraryPageUrl(link, null).href).toBe('https://blok.test/library/teamspaces?workspace=atelier');
    expect(libraryPageId(libraryPageUrl(link, 'b'))).toBe('b');
    expect(editorUrl(link).href).toBe('https://blok.test/?workspace=atelier');
    expect(calendarUrl(link).href).toBe('https://blok.test/calendar?workspace=atelier');
    expect(libraryUrl(link, 'favorites').href).toBe('https://blok.test/library/favorites?workspace=atelier');
  });
  it('resolves supported library tabs on reload and ignores other paths', () => {
    expect(libraryView(new URL('https://blok.test/library/shared/'))).toBe('shared');
    expect(libraryView(new URL('https://blok.test/library/anything'))).toBeUndefined();
  });
});
