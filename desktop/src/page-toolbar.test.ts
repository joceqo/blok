import {afterEach, describe, expect, it, vi} from 'vitest';
import {createPageToolbar} from './page-toolbar';
import {must} from './test-helpers';
import type {PageBreadcrumbItem, PageToolbarOptions} from './page-toolbar';

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

function mount(items: PageBreadcrumbItem[], options: PageToolbarOptions = {}, fullWidth = false,
  onFullWidthChange = vi.fn(), onShare?: (anchor: HTMLButtonElement) => (() => void) | void) {
  const toolbar = createPageToolbar(items, fullWidth, onFullWidthChange, undefined, onShare, options);
  document.body.append(toolbar.element);
  return toolbar;
}

const inBar = <T extends Element>(toolbar: {element: HTMLElement}, selector: string): T | null =>
  toolbar.element.querySelector<T>(selector);

/** Les surfaces Base UI arrivent au tour suivant : on les attend. */
const opened = (toolbar: {element: HTMLElement}, selector: string) =>
  vi.waitFor(() => must(inBar<HTMLElement>(toolbar, selector)));

async function openPageMenu(toolbar: {element: HTMLElement}) {
  must(inBar<HTMLButtonElement>(toolbar, '[data-desktop-page-more]')).click();
  return opened(toolbar, '[data-desktop-page-menu]');
}

describe('copier le lien de la page', () => {
  it('copie l’adresse de la page courante et le dit', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
    const toolbar = mount([{id: 'old', title: 'Old'}], {pageUrl: id => `https://blok.example.com/?page=${id}`});
    toolbar.setBreadcrumbs([{id: 'current', title: 'Current'}]);
    must(inBar<HTMLButtonElement>(toolbar, '[data-desktop-page-copy]')).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('https://blok.example.com/?page=current'));
    const status = await vi.waitFor(() => {
      const node = must(inBar<HTMLElement>(toolbar, '[role="status"]'));
      expect(node.textContent).toBe('Lien copié');
      return node;
    });
    expect(status.hidden).toBe(false);
    expect(must(inBar<HTMLButtonElement>(toolbar, '[data-desktop-page-copy]')).title).toBe('Lien copié');
    toolbar.destroy();
  });

  it('avoue l’échec plutôt que d’annoncer une réussite', async () => {
    Object.defineProperty(navigator, 'clipboard', {configurable: true,
      value: {writeText: vi.fn().mockRejectedValue(new Error('Denied'))}});
    const toolbar = mount([{id: 'p', title: 'Page'}], {pageUrl: () => 'https://blok.example.com/'});
    must(inBar<HTMLButtonElement>(toolbar, '[data-desktop-page-copy]')).click();
    await vi.waitFor(() => expect(inBar(toolbar, '[role="status"]')?.textContent).toContain('Copie impossible'));
    expect(must(inBar<HTMLElement>(toolbar, '[role="status"]')).hidden).toBe(false);
    toolbar.destroy();
  });
});

describe('menu de la page', () => {
  it('bascule la pleine largeur et garde le choix visible', async () => {
    const onFullWidthChange = vi.fn();
    const toolbar = mount([{id: 'plan', title: 'Plan', icon: '🏈'}], {}, false, onFullWidthChange);
    expect(inBar(toolbar, '[data-desktop-page-toolbar-title]')?.textContent).toBe('Plan');
    await openPageMenu(toolbar);
    const choice = must(inBar<HTMLButtonElement>(toolbar, '[data-desktop-page-full-width]'));
    expect(choice.getAttribute('aria-checked')).toBe('false');
    choice.click();
    expect(onFullWidthChange).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(must(inBar(toolbar, '[data-desktop-page-full-width]')).getAttribute('aria-checked')).toBe('true'));
    toolbar.destroy();
  });

  it('suit le titre et l’icône de la page courante', () => {
    const toolbar = mount([{id: 'plan', title: 'Plan', icon: '🏈'}]);
    toolbar.setTitle('Nouveau plan');
    toolbar.setIcon('🚗');
    expect(inBar(toolbar, '[data-desktop-page-toolbar-title]')?.textContent).toBe('Nouveau plan');
    expect(inBar(toolbar, '[data-desktop-page-toolbar-icon]')?.textContent).toBe('🚗');
    toolbar.destroy();
  });

  it('rend le clavier et le focus à Base UI, et le déclencheur au retour', async () => {
    const toolbar = mount([{id: 'page', title: 'Page'}], {onHistory: () => () => {}, onRename: vi.fn()});
    const trigger = must(inBar<HTMLButtonElement>(toolbar, '[data-desktop-page-more]'));
    trigger.click();
    const menu = await opened(toolbar, '[data-desktop-page-menu]');
    expect([...menu.querySelectorAll('button')].map(node => node.textContent))
      .toEqual(['Pleine largeur', 'Historique des versions', 'Renommer']);
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await vi.waitFor(() => expect(inBar(toolbar, '[data-desktop-page-menu]')).toBeNull());
    toolbar.destroy();
  });
});

describe('fil d’Ariane', () => {
  it('montre le parent et la page courante avec leurs icônes, et ouvre le parent', () => {
    const onOpen = vi.fn();
    const toolbar = mount([
      {id: 'parent', title: 'Nouvelle page', icon: '🏕️', onOpen},
      {id: 'child', title: 'jojo', icon: '🎸'},
    ]);
    const nav = must(inBar(toolbar, 'nav[aria-label="Fil d’Ariane"]'));
    const entries = [...nav.querySelectorAll('[data-desktop-page-breadcrumb-item]')];
    expect(entries.map(item => item.textContent)).toEqual(['🏕️Nouvelle page', '🎸jojo']);
    expect(nav.querySelector('[data-desktop-page-breadcrumb-separator]')?.textContent).toBe('/');
    expect(entries[1]?.querySelector('[aria-current="page"]')).not.toBeNull();
    entries[0]?.querySelector('button')?.click();
    expect(onOpen).toHaveBeenCalledOnce();

    toolbar.setBreadcrumbs([
      {id: 'parent', title: 'Page renommée', icon: '🚗', onOpen},
      {id: 'child', title: 'jojo', icon: '🎸'},
    ]);
    expect(must(inBar(toolbar, 'nav')).textContent).toContain('🚗Page renommée/🎸jojo');
    toolbar.destroy();
  });

  it('ne nomme plus l’espace au-dessus de la page', () => {
    // Un fil nomme les parents d'une page. L'espace n'en est pas un : son nom
    // est déjà dans la barre latérale. La place reste libre pour un espace
    // d'équipe, qui lui est un vrai parent.
    const toolbar = mount([{id: 'p', title: 'Nouvelle page'}]);
    expect(inBar(toolbar, '[data-desktop-page-workspace]')).toBeNull();
    expect(toolbar.element.textContent).toContain('Nouvelle page');
    toolbar.destroy();
  });

  it('ouvre la page quand on clique une miette d’ancêtre, pas son menu', () => {
    const open = vi.fn();
    const toolbar = mount([
      {id: 'parent', title: 'Bienvenue', onOpen: open, menu: [{id: 'sib', title: 'Autre', onOpen: vi.fn()}]},
      {id: 'current', title: 'Droits', menu: [{id: 'sib', title: 'Autre', onOpen: vi.fn()}]},
    ]);
    const crumbs = [...toolbar.element.querySelectorAll<HTMLButtonElement>('[data-desktop-page-breadcrumb-item] button')];
    const parent = must(crumbs.find(node => node.textContent?.includes('Bienvenue')));
    parent.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(parent.getAttribute('aria-haspopup')).toBeNull();
    // La page courante n'a nulle part où aller : c'est à elle que va le menu.
    expect(must(crumbs.find(node => node.textContent?.includes('Droits'))).getAttribute('aria-haspopup')).toBe('menu');
    toolbar.destroy();
  });

  it('descend dans les sous-pages, revient, et déplie le reste', async () => {
    const openSibling = vi.fn();
    const deep = Array.from({length: 8}, (_, index) => ({id: 'd' + index, title: 'Page ' + index, onOpen: vi.fn()}));
    const toolbar = mount([{
      id: 'child', title: 'jojo', icon: '🎸', menuHeading: 'Nouvelle page', menu: [
        {id: 'child', title: 'jojo', icon: '🎸', current: true, children: deep, onOpen: vi.fn()},
        {id: 'sibling', title: 'Autre page', onOpen: openSibling},
      ],
    }]);
    must(inBar<HTMLButtonElement>(toolbar, '[data-page-id="child"] button')).click();
    const menu = await opened(toolbar, '[data-desktop-breadcrumb-menu]');
    expect(menu.querySelector('[data-desktop-breadcrumb-menu-heading]')?.textContent).toBe('Nouvelle page');
    expect(menu.querySelector('[data-desktop-breadcrumb-menu-item="child"]')?.getAttribute('aria-current')).toBe('page');

    must(menu.querySelector<HTMLButtonElement>('[data-desktop-breadcrumb-menu-children]')).click();
    await vi.waitFor(() => expect(menu.querySelector('[data-desktop-breadcrumb-menu-heading]')?.textContent).toBe('jojo'));
    // Huit sous-pages, six montrées : le reste attend derrière « 2 autres ».
    expect(menu.querySelectorAll('[data-desktop-breadcrumb-menu-item]')).toHaveLength(6);
    must(menu.querySelector<HTMLButtonElement>('[data-desktop-breadcrumb-menu-more]')).click();
    await vi.waitFor(() => expect(menu.querySelectorAll('[data-desktop-breadcrumb-menu-item]')).toHaveLength(8));

    must(menu.querySelector<HTMLButtonElement>('[data-desktop-breadcrumb-menu-back]')).click();
    await vi.waitFor(() => expect(menu.querySelector('[data-desktop-breadcrumb-menu-heading]')?.textContent).toBe('Nouvelle page'));
    must(menu.querySelector<HTMLButtonElement>('[data-desktop-breadcrumb-menu-item="sibling"]')).click();
    expect(openSibling).toHaveBeenCalledOnce();
    toolbar.destroy();
  });

  it('se tait quand l’espace n’a aucune page à proposer', async () => {
    const toolbar = mount([{id: 'p', title: 'Page', menuHeading: 'Pages', menu: []}]);
    must(inBar<HTMLButtonElement>(toolbar, '[data-page-id="p"] button')).click();
    const menu = await opened(toolbar, '[data-desktop-breadcrumb-menu]');
    expect(menu.textContent).toContain('Aucune page dans cet espace');
    toolbar.destroy();
  });
});

describe('où la page est enregistrée', () => {
  it('le dit dans le menu plutôt que dans la barre', async () => {
    const toolbar = mount([{id: 'p', title: 'Page'}], {storedOnDevice: true});
    // La barre du haut nomme la page ; où elle dort est de second plan.
    expect(must(inBar(toolbar, '[data-desktop-page-identity]')).querySelector('[data-desktop-page-local]')).toBeNull();
    const menu = await openPageMenu(toolbar);
    expect(must(menu.querySelector('[data-desktop-page-local]')).textContent).toContain('Sur cet appareil');
    toolbar.destroy();
  });

  it('se tait pour une page qui vit sur un serveur', async () => {
    const toolbar = mount([{id: 'p', title: 'Page'}]);
    await openPageMenu(toolbar);
    expect(inBar(toolbar, '[data-desktop-page-local]')).toBeNull();
    toolbar.destroy();
  });
});

describe('présences et partage', () => {
  it('résume les lecteurs au-delà de deux, et disparaît quand il n’y en a plus', () => {
    const toolbar = mount([{id: 'p', title: 'Page'}], {onHistory: () => () => {}});
    toolbar.setPeers(['Ana', 'Bo', 'Cy']);
    const peers = must(inBar<HTMLElement>(toolbar, '[data-desktop-page-peers]'));
    expect(peers.textContent).toBe('Ana, Bo +1');
    expect(peers.getAttribute('aria-label')).toBe('Sur cette page · Ana, Bo, Cy');
    toolbar.setPeers([]);
    expect(must(inBar<HTMLElement>(toolbar, '[data-desktop-page-peers]')).hidden).toBe(true);
    toolbar.destroy();
  });

  it('remet le partage à son bouton, et le referme en partant', () => {
    const close = vi.fn();
    const anchors: HTMLButtonElement[] = [];
    const toolbar = mount([{id: 'p', title: 'Page'}], {}, false, vi.fn(), anchor => { anchors.push(anchor); return close; });
    const share = must(inBar<HTMLButtonElement>(toolbar, '[data-desktop-page-share]'));
    share.click();
    expect(anchors).toEqual([share]);
    toolbar.destroy();
    expect(close).toHaveBeenCalledOnce();
  });
});
