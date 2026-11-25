import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPageFrame } from '../../../src/shell/sidebar';
import type { ShellPage } from '../../../src/shell/sidebar';

const page = (id: string, over: Partial<ShellPage> = {}): ShellPage => ({ id, title: id, parentId: null, ...over });

function mount(pages: ShellPage[], activeId = '') {
  const frame = createPageFrame({ pages, activeId, onOpen: () => {}, onCreate: () => {} });
  document.body.append(frame.element);
  return frame;
}

const headings = (): string[] =>
  [...document.querySelectorAll('[data-blok-sidebar-section-label]')].map((node) => node.textContent ?? '');

beforeEach(() => document.body.replaceChildren());

describe('sidebar sections', () => {
  // Chez Notion, Favoris n'apparaît qu'une fois la première page mise en favori.
  it('shows Favorites only once something is favorited', () => {
    mount([page('a'), page('b')]);
    expect(headings()).not.toContain('Favoris');
    document.body.replaceChildren();
    mount([page('a', { favorite: true }), page('b')]);
    expect(headings()).toContain('Favoris');
  });

  // Une page en favori reste à sa place dans l'arbre : Favoris est un raccourci,
  // pas un déplacement.
  it('keeps a favorited page in its own section too', () => {
    mount([page('a', { favorite: true, section: 'Équipe' })]);
    expect(headings()).toEqual(['Favoris', 'Équipe']);
    expect(document.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(2);
  });

  // Recents se remplit en ouvrant des pages, la plus récente en tête.
  it('builds Recents from what was opened, most recent first', () => {
    const frame = mount([page('a'), page('b'), page('c')]);
    frame.setPages([page('a'), page('b'), page('c')], 'b');
    frame.setPages([page('a'), page('b'), page('c')], 'c');
    expect(headings()).toContain('Récents');
    const recents = document.querySelector('[data-blok-sidebar-recents]');
    expect([...(recents?.querySelectorAll('[data-blok-sidebar-row] [data-blok-sidebar-label]') ?? [])].map((node) => node.textContent))
      .toEqual(['c', 'b']);
  });

  it('keeps visible recents in place and only promotes a page outside the five shortcuts', () => {
    const pages = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => page(id));
    const frame = mount(pages, 'a');
    for (const id of ['b', 'c', 'd', 'e']) frame.setPages(pages, id);
    const titles = () => [...frame.element.querySelectorAll('[data-blok-sidebar-recents] [data-blok-sidebar-label]')].map((item) => item.textContent);
    frame.setPages(pages, 'c'); expect(titles()).toEqual(['e', 'd', 'c', 'b', 'a']);
    frame.setPages(pages, 'f'); expect(titles()).toEqual(['f', 'e', 'd', 'c', 'b']);
    frame.setPages(pages, 'a'); expect(titles()).toEqual(['a', 'f', 'e', 'd', 'c']);
  });

  // Notion replie une section d'un clic sur son titre.
  it('collapses a section when its heading is clicked', () => {
    mount([page('a', { section: 'Équipe' }), page('b', { section: 'Privé' })]);
    const heading = document.querySelector<HTMLButtonElement>('[data-blok-sidebar-section-label]');
    expect(document.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(2);
    heading?.click();
    expect(document.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(1);
    // Le repeint recrée le titre : on relit le DOM plutôt que la référence.
    const after = document.querySelector<HTMLButtonElement>('[data-blok-sidebar-section-label]');
    expect(after?.getAttribute('aria-expanded')).toBe('false');
    after?.click();
    expect(document.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(2);
  });

  // Le repli d'une section est une icône qui pivote, comme l'en-tête d'espace
  // d'équipe juste au-dessus. Deux caractères typographiques qui se remplacent
  // — « ⌄ » puis « › » — ont deux chasses et deux hauteurs : la marque saute et
  // change de taille à chaque clic au lieu de tourner.
  it('marks a section with one chevron that merely rotates', () => {
    mount([page('a', { section: 'Équipe' })]);
    const heading = document.querySelector<HTMLButtonElement>('[data-blok-sidebar-section-label]');
    const mark = heading?.querySelector('[data-blok-sidebar-section-chevron]');
    expect(mark?.tagName.toLowerCase()).toBe('svg');
    const expanded = mark?.outerHTML;
    heading?.click();
    const collapsed = document.querySelector('[data-blok-sidebar-section-chevron]');
    expect(collapsed?.outerHTML).toBe(expanded);
    expect(document.querySelector('[data-blok-sidebar-section-label]')?.getAttribute('aria-expanded')).toBe('false');
  });

  // Le README de la famille d'icônes l'interdit : « Do not use opacity tints,
  // gradients, font glyphs, embedded images, or external SVG references. »
  it('draws no disclosure mark out of the font', () => {
    const css = readFileSync(join(__dirname, '../../../src/shell/sidebar.css'), 'utf8');
    expect(css).not.toMatch(/\[data-blok-sidebar-section-label\][^{]*::after[^{]*\{[^}]*content:/);
  });

  it('drops a section that has nothing in it', () => {
    mount([page('a', { section: 'Équipe' })]);
    expect(headings()).toEqual(['Équipe']);
  });

  it('opens the host palette from its search field and both keyboard shortcuts', () => {
    let opens = 0;
    const frame = createPageFrame({ pages: [], activeId: '', onCreate() {}, onOpen() {}, onSearch() { opens++; } });
    document.body.append(frame.element);
    const trigger = frame.element.querySelector<HTMLButtonElement>('button[data-blok-sidebar-search]')!;
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger.querySelector('kbd')?.textContent).toMatch(/K$/);
    trigger.click();
    for (const key of ['p', 'k']) {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true }));
    }
    expect(opens).toBe(3);
  });

  // La recherche traverse les sections : on cherche une page, pas une section.
  it('searches across every section at once', () => {
    mount([page('alpha', { section: 'Équipe' }), page('beta', { section: 'Privé' })]);
    const input = document.querySelector<HTMLInputElement>('[data-blok-sidebar-search] input');
    input!.value = 'bet';
    input!.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(1);
    expect(headings()).toEqual(['Privé']);
  });
});

describe('teamspace row', () => {
  it('keeps creation and settings separate from the workspace disclosure', () => {
    const created: (string | null)[] = []; let settings = 0;
    const frame = createPageFrame({ pages: [page('a', { section: 'workspace' })], activeId: '',
      onOpen() {}, onCreate: (id) => created.push(id), onTeamspaceMenu() { settings++; }, teamspace: { name: 'Équipe' },
    });
    document.body.append(frame.element);
    frame.element.querySelector<HTMLButtonElement>('[data-blok-sidebar-teamspace-add]')!.click();
    frame.element.querySelector<HTMLButtonElement>('[data-blok-sidebar-teamspace-more]')!.click();
    expect(created).toEqual([null]); expect(settings).toBe(1);
    expect(frame.element.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(1);
  });
  // Chez Notion, l'espace n'est pas un titre : c'est une ligne avec son icône,
  // sous un en-tête « Espaces », et les pages sont indentées dessous.
  it('puts the workspace on a row of its own under Espaces', () => {
    const frame = createPageFrame({
      pages: [page('a', { section: 'workspace' })],
      activeId: '', onOpen: () => {}, onCreate: () => {},
      teamspace: { name: 'Tousambassadeurs' },
    });
    document.body.append(frame.element);
    expect(headings()).toContain("Espaces d’équipe");
    expect(document.querySelector('[data-blok-sidebar-teamspace]')?.textContent).toContain('Tousambassadeurs');
    expect(document.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(1);
  });

  it('collapses the workspace row, hiding its pages but not the other sections', () => {
    const frame = createPageFrame({
      pages: [page('a', { section: 'workspace' }), page('b', { section: 'Privé' })],
      activeId: '', onOpen: () => {}, onCreate: () => {},
      teamspace: { name: 'Tousambassadeurs' },
    });
    document.body.append(frame.element);
    expect(document.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(2);
    document.querySelector<HTMLButtonElement>('[data-blok-sidebar-teamspace] button')?.click();
    expect(document.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(1);
  });

  it('stays a plain heading when there is no workspace to name', () => {
    mount([page('a', { section: 'Privé' })]);
    expect(headings()).toEqual(['Privé']);
    expect(document.querySelector('[data-blok-sidebar-teamspace]')).toBeNull();
  });
});

describe('sidebar shortcuts', () => {
  it('opens workspace destinations and keeps the current mode in sync with the host', () => {
    const calls: string[] = [];
    const frame = createPageFrame({
      pages: [page('a')], activeId: 'a', onOpen() {}, onCreate() {},
      onChat: () => calls.push('chat'), onHome: () => calls.push('home'),
      onCalendar: () => calls.push('calendar'), calendarHref: '/calendar',
      onNewChat: () => calls.push('new'), onLibrary: ids => calls.push(ids.join(',')),
    });
    document.body.append(frame.element);
    const modes = frame.element.querySelector('[data-blok-sidebar-modes]')!;
    const home = modes.querySelector<HTMLButtonElement>('[aria-label="Accueil"]')!;
    const chat = modes.querySelector<HTMLButtonElement>('[aria-label="Discussions"]')!;
    const calendar = modes.querySelector<HTMLAnchorElement>('a')!;
    expect(home.getAttribute('aria-current')).toBe('page');
    chat.click(); frame.setChatActive(true);
    expect(chat.getAttribute('aria-current')).toBe('page');
    expect(home.hasAttribute('aria-current')).toBe(false);
    calendar.click(); frame.setCalendarActive(true);
    expect(calendar.getAttribute('aria-current')).toBe('page');
    expect(chat.hasAttribute('aria-current')).toBe(false);
    frame.setCalendarActive(false); home.click();
    expect(home.getAttribute('aria-current')).toBe('page');
    expect(frame.element.querySelector('[data-blok-sidebar-recents]')).toBeNull();
    const rows = frame.element.querySelectorAll<HTMLButtonElement>('[data-blok-sidebar-shortcuts] > [data-blok-sidebar-shortcut]');
    rows.forEach(row => row.click());
    expect(calls).toEqual(['chat', 'calendar', 'home', 'new', 'a']);
  });

  it('keeps hidden shortcuts scoped to one workspace and preserves the underlying pages', () => {
    const key = 'blok:sidebar:sections:atelier';
    localStorage.setItem(key, JSON.stringify({events:false, favorites:false}));
    try {
      const settings = {
        pages: [page('rapport', {favorite:true, section:'Privé'})], activeId: '',
        onHome() {}, onOpen() {}, onCalendar() {}, onCreate() {},
      };
      const hidden = createPageFrame({...settings, preferenceKey:'atelier'});
      expect(hidden.element.querySelector('[data-blok-sidebar-favorites]')).toBeNull();
      expect(hidden.element.querySelector('[data-blok-sidebar-tree]')?.textContent).not.toContain('Événements à venir');
      expect(hidden.element.querySelector('[data-blok-sidebar-link]')?.textContent).toBe('rapport');
      let invited = false;
      const other = createPageFrame({...settings, preferenceKey:'autre', onInviteMembers:() => { invited = true; }});
      expect(other.element.querySelector('[data-blok-sidebar-favorites]')).not.toBeNull();
      const invite = [...other.element.querySelectorAll('button')].find(node => node.textContent === 'Inviter des membres');
      invite?.click();
      expect(invited).toBe(true);
      expect(hidden.element.textContent).not.toContain('Inviter des membres');
    } finally { localStorage.removeItem(key); }
  });

  it('offers New page as a row, not only as a header button', () => {
    mount([page('a')]);
    const shortcut = document.querySelector<HTMLButtonElement>('[data-blok-sidebar-shortcut]');
    expect(shortcut?.textContent).toContain('Nouvelle page');
  });

  it('creates at the root from that shortcut', () => {
    const created: (string | null)[] = [];
    const frame = createPageFrame({ pages: [page('a')], activeId: '', onOpen: () => {}, onCreate: (parent) => created.push(parent) });
    document.body.append(frame.element);
    document.querySelector<HTMLButtonElement>('[data-blok-sidebar-shortcut]')?.click();
    expect(created).toEqual([null]);
  });
});

it('keeps recent shortcuts flat even if the page has nested children', () => {
  const frame = mount([page('parent'), page('child', { parentId: 'parent' })], 'parent');
  const recent = frame.element.querySelector('[data-blok-sidebar-recents]');
  expect(recent?.querySelectorAll('[data-blok-sidebar-row]')).toHaveLength(1);
  expect(recent?.querySelector('[data-blok-sidebar-toggle]')).toBeNull();
  expect(frame.element.querySelectorAll('[data-blok-sidebar-label]')).toHaveLength(3);
});

it('keeps copying and favoriting readable pages while hiding unavailable editing actions', () => {
  const frame = createPageFrame({ pages: [page('shared')], activeId: '', onOpen() {}, onCreate() {},
    canEdit: () => false, canCreate: () => false, availableActions: ['rename', 'duplicate', 'delete', 'open-tab'],
  });
  document.body.append(frame.element);
  const commands = [...frame.element.querySelectorAll('[data-blok-sidebar-menu-label]')].map(node => node.textContent);
  expect(commands).toEqual(['Ajouter aux favoris', 'Copier le lien', 'Ouvrir dans un nouvel onglet']);
  expect(frame.element.querySelector<HTMLButtonElement>('[data-blok-sidebar-add]')?.hidden).toBe(true);
});

it('offers private creation even before the first private page exists', () => {
  let created = 0;
  const frame = createPageFrame({ pages: [], activeId: '', onOpen() {}, onCreate() {}, onCreatePrivate() { created++; } });
  document.body.append(frame.element);
  expect(headings()).toContain('Privé');
  frame.element.querySelector<HTMLButtonElement>('[data-blok-sidebar-create-private]')!.click();
  expect(created).toBe(1);
});

it('adds a keyboard-accessible sidebar shortcut only when the host provides remote teams', () => {
  const options = { pages: [], activeId: '', onOpen() {}, onCreate() {} };
  const local = createPageFrame(options);
  expect(local.element.textContent).not.toContain('Espaces d’équipe');
  let opened = 0;
  const onTeamspaces = () => { opened++; };
  const remote = createPageFrame({ ...options, onTeamspaces });
  const shortcut = [...remote.element.querySelectorAll('button')].find((item) => item.textContent === 'Espaces d’équipe')!;
  expect(shortcut.getAttribute('aria-haspopup')).toBe('dialog');
  shortcut.click();
  expect(opened).toBe(1);
});

it('distinguishes the team directory from the workspace pages toggle', () => {
  const options = { pages: [page('Guide', { section: 'workspace' })], activeId: 'Guide',
    teamspace: { name: 'Atelier' }, onOpen() {}, onCreate() {} };
  const legacy = createPageFrame(options);
  expect([...legacy.element.querySelectorAll('[data-blok-sidebar-section-label]')].map((label) => label.textContent)).toContain('Espaces d’équipe');
  const frame = createPageFrame({ ...options, onTeamspaces() {} });
  const buttons = [...frame.element.querySelectorAll('button')];
  const teams = buttons.filter((button) => button.textContent === 'Espaces d’équipe');
  expect(teams).toHaveLength(1);
  expect(teams[0]?.getAttribute('aria-haspopup')).toBe('dialog');
  const pages = buttons.find((button) => button.textContent === 'Pages de l’espace')!;
  expect(pages.getAttribute('aria-expanded')).toBe('true');
  pages.click();
  expect(frame.element.querySelector('[data-blok-sidebar-teamspace-pages]')).toBeNull();
});

it('links the teamspace section header to the library independently of collapsing it', () => {
  const onTeamspaces = vi.fn();
  const frame = createPageFrame({pages:[], activeId:'', teamspace:{name:'Atelier'}, onHome() {}, onTeamspaces, onOpen() {}, onCreate() {}});
  const link = frame.element.querySelector<HTMLButtonElement>('[data-blok-sidebar-section-action]')!;
  expect(link.getAttribute('aria-label')).toBe('Ouvrir les espaces d’équipe dans la bibliothèque');
  expect(link.hasAttribute('aria-haspopup')).toBe(false);
  link.click();
  expect(onTeamspaces).toHaveBeenCalledOnce();
  const heading = link.parentElement?.querySelector('[data-blok-sidebar-section-label]');
  expect(heading?.textContent).toBe('Espaces d’équipe');
  expect(heading?.getAttribute('aria-expanded')).toBe('true');
});
