import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {DesktopPage} from './storage';
import {mountWorkspaceLibrary, type LibraryView} from './workspace-library';

let host: HTMLDivElement;
let library: ReturnType<typeof mountWorkspaceLibrary>;
let view: LibraryView;
let pages: DesktopPage[];
let inTeamspaces = false;
let peekPage: string | undefined;
const createTeamspace = vi.fn();
const onOpen = vi.fn();

function show(next: LibraryView) {
  view = next;
  library.refresh();
}
function titles() {
  return [...host.querySelectorAll('[data-blok-database-cell="title"]')].map(cell => cell.textContent);
}
function cell(id: string) {
  return host.querySelector<HTMLElement>(`[data-row-id="${id}"] [role=gridcell][data-property-id=name]`)!;
}
function openButton(id: string) {
  return cell(id).querySelector<HTMLButtonElement>('[data-blok-database-table-open]')!;
}
const onClosePeek = vi.fn();
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  view = 'recents'; inTeamspaces = false; peekPage = undefined;
  pages = [
    {id: 'a', title: 'Projet', parentId: null, section: 'Partagé', favorite: true},
    {id: 'b', title: 'Brouillon', parentId: null, section: 'Privé'},
    {id: 'c', title: 'Enfant', parentId: 'b'},
    {id: 'd', title: 'Autre', parentId: null, section: 'workspace'},
  ];
  library = mountWorkspaceLibrary(host, {
    workspaceName: 'Atelier', pages: () => pages, view: () => view, onViewChange: show,
    recentIds: () => ['deleted', 'a', 'b'], visitedAt: id => id === 'c' ? 123 : undefined,
    onOpen, onClosePeek, isTeamspaces: () => inTeamspaces, selectedPageId: () => peekPage, onCreateTeamspace: createTeamspace,
  });
});
afterEach(() => {
  library.destroy();
  host.remove();
  vi.clearAllMocks();
});

it('orders real visits first and includes accessible entries from older local history', () => {
  expect(titles()).toEqual(['Enfant', 'Projet', 'Brouillon']);
  expect(library.getVisiblePageIds()).toEqual(['c', 'a', 'b']);
  expect(document.activeElement?.textContent).toBe('Bibliothèque');
});

it('uses favorites and inherited page visibility, and refuses to open revoked pages', () => {
  host.querySelector<HTMLButtonElement>('button[aria-current]')!.focus();
  Array.from(host.querySelectorAll('nav button')).find(el => el.textContent?.trim() === 'Privé')!
    .dispatchEvent(new MouseEvent('click', {bubbles:true}));
  expect(titles()).toEqual(['Brouillon', 'Enfant']);
  show('shared');
  expect(titles()).toEqual(['Projet']);
  show('favorites');
  openButton('a').click();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('a');
  pages = [];
  openButton('a').click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  library.refresh();
  expect(host.querySelector('[role=status]')?.textContent).toContain('vos favoris');
});

it('can show parent locations, filter nested pages and sort by title', async () => {
  show('private');
  host.querySelector<HTMLButtonElement>('button[aria-label="Options d’affichage"]')!.click();
  await vi.waitFor(() => expect(host.querySelector('input[type=checkbox]')).not.toBeNull());
  host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
  await vi.waitFor(() => expect(host.querySelector('[data-row-id=c] [data-blok-database-cell=text]')?.textContent).toBe('Brouillon'));
  host.querySelector<HTMLButtonElement>('button[aria-label="Filtrer"]')!.click();
  await vi.waitFor(() => expect(host.querySelector('.library-menu')?.textContent).toBe('Pages de premier niveau'));
  host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
  await vi.waitFor(() => expect(titles()).toEqual(['Brouillon']));
  show('recents');
  host.querySelector<HTMLButtonElement>('button[aria-label="Options d’affichage"]')!.click();
  await vi.waitFor(() => expect(host.querySelector('.library-menu select')).not.toBeNull());
  const sort = host.querySelector<HTMLSelectElement>('.library-menu select')!;
  sort.value = 'asc'; sort.dispatchEvent(new Event('change', {bubbles:true}));
  await vi.waitFor(() => expect(titles()).toEqual(['Brouillon', 'Projet']));
  expect(library.getVisiblePageIds()).toEqual(['b', 'a']);
});


it.each(['recents','favorites','private','shared'] as const)('uses the same read-only database grid and native row action in %s', async target => {
  show(target);
  const id = library.getVisiblePageIds()[0];
  const grid = host.querySelector<HTMLElement>('[data-blok-database-table-grid]')!;
  expect(grid.getAttribute('aria-readonly')).toBe('true');
  expect(grid.querySelector('[contenteditable=true]')).toBeNull();
  cell(id).click();
  expect(cell(id).getAttribute('aria-selected')).toBe('true');
  expect(onOpen).not.toHaveBeenCalled();
  cell(id).dispatchEvent(new KeyboardEvent('keydown', {bubbles:true, key:'Enter', ctrlKey:true}));
  expect(onOpen).toHaveBeenCalledWith(id);
  peekPage = id;
  library.refresh();
  expect(openButton(id).textContent?.trim()).toBe('Fermer');
  openButton(id).click();
  expect(onClosePeek).toHaveBeenCalledOnce();
});

it('creates a teamspace using the contextual library action', () => {
  inTeamspaces = true;
  library.refresh();
  host.querySelector<HTMLButtonElement>('.library-create')!.click();
  expect(createTeamspace).toHaveBeenCalledOnce();
});
