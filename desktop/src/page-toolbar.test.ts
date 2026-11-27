import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageToolbar } from './page-toolbar';
import { must } from './test-helpers';

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('page appearance toolbar', () => {
  it('copies the current page URL from the host and shows visible success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const toolbar = createPageToolbar([{ id: 'old', title: 'Old' }], false, vi.fn(), undefined, undefined, { pageUrl: id => `https://blok.example.com/?page=${id}` });
    document.body.append(toolbar.element);
    toolbar.setBreadcrumbs([{ id: 'current', title: 'Current' }]);
    const copy = toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-copy]')!;
    copy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('https://blok.example.com/?page=current'));
    const status = toolbar.element.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toBe('Lien copié'); expect(status.hidden).toBe(false);
    expect(copy.title).toBe('Lien copié');
    toolbar.destroy();
  });

  it('shows a failure instead of claiming success when clipboard access is refused', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    const toolbar = createPageToolbar([{ id: 'p', title: 'Page' }], false, vi.fn());
    document.body.append(toolbar.element);
    toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-copy]')!.click();
    await vi.waitFor(() => expect(toolbar.element.querySelector('[role="status"]')?.textContent).toContain('Copie impossible'));
    expect(toolbar.element.querySelector<HTMLElement>('[role="status"]')!.hidden).toBe(false);
    toolbar.destroy();
  });
  it('changes a page to full width and keeps the choice visible in the menu', () => {
    const onFullWidthChange = vi.fn();
    const toolbar = createPageToolbar([{ id: 'plan', title: 'Plan', icon: '🏈' }], false, onFullWidthChange);
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector('[data-desktop-page-toolbar-title]')?.textContent).toBe('Plan');
    toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-more]')!.click();
    const choice = toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-full-width]')!;
    expect(choice.getAttribute('aria-checked')).toBe('false');
    choice.click();
    expect(choice.getAttribute('aria-checked')).toBe('true');
    expect(onFullWidthChange).toHaveBeenCalledWith(true);
    toolbar.setTitle('Nouveau plan');
    toolbar.setIcon('🚗');
    expect(toolbar.element.querySelector('[data-desktop-page-toolbar-title]')?.textContent).toBe('Nouveau plan');
    expect(toolbar.element.querySelector('[data-desktop-page-toolbar-icon]')?.textContent).toBe('🚗');
    toolbar.destroy();
  });

  it('shows the parent and current page with their icons and opens the parent', () => {
    const onOpen = vi.fn();
    const toolbar = createPageToolbar([
      { id: 'parent', title: 'Nouvelle page', icon: '🏕️', onOpen },
      { id: 'child', title: 'jojo', icon: '🎸' },
    ], false, vi.fn());

    document.body.append(toolbar.element);
    const nav = toolbar.element.querySelector('nav[aria-label="Fil d’Ariane"]');
    const entries = nav?.querySelectorAll('[data-desktop-page-breadcrumb-item]');

    expect(Array.from(entries ?? []).map((item) => item.textContent)).toEqual(['🏕️Nouvelle page', '🎸jojo']);
    expect(nav?.querySelector('[data-desktop-page-breadcrumb-separator]')?.textContent).toBe('/');
    expect(entries?.[1]?.querySelector('[aria-current="page"]')).not.toBeNull();
    entries?.[0]?.querySelector('button')?.click();
    expect(onOpen).toHaveBeenCalledOnce();

    toolbar.setBreadcrumbs([
      { id: 'parent', title: 'Page renommée', icon: '🚗', onOpen },
      { id: 'child', title: 'jojo', icon: '🎸' },
    ]);
    expect(nav?.textContent).toContain('🚗Page renommée/🎸jojo');
    toolbar.destroy();
  });

  it('opens each breadcrumb menu and navigates from its page list', () => {
    const openSibling = vi.fn();
    const toolbar = createPageToolbar([
      { id: 'parent', title: 'Nouvelle page', icon: '🏕️', menuHeading: 'Pages locales', menu: [
        { id: 'parent', title: 'Nouvelle page', icon: '🏕️', current: true, children: [
          { id: 'child', title: 'jojo', icon: '🎸', current: true, onOpen: vi.fn() },
        ], onOpen: vi.fn() },
      ] },
      { id: 'child', title: 'jojo', icon: '🎸', menuHeading: 'Nouvelle page', menu: [
        { id: 'child', title: 'jojo', icon: '🎸', current: true, onOpen: vi.fn() },
        { id: 'sibling', title: 'Autre page', onOpen: openSibling },
      ] },
    ], false, vi.fn());

    document.body.append(toolbar.element);
    const child = toolbar.element.querySelector<HTMLButtonElement>('[data-page-id="child"] > button')!;

    child.click();
    const menu = toolbar.element.querySelector<HTMLElement>('[data-desktop-breadcrumb-menu]')!;

    expect(menu.hidden).toBe(false);
    expect(child.getAttribute('aria-expanded')).toBe('true');
    expect(menu.querySelector('[data-desktop-breadcrumb-menu-heading]')?.textContent).toBe('Nouvelle page');
    expect(menu.querySelector('[data-desktop-breadcrumb-menu-item="child"]')?.getAttribute('aria-current')).toBe('page');
    menu.querySelector<HTMLButtonElement>('[data-desktop-breadcrumb-menu-item="sibling"]')?.click();
    expect(openSibling).toHaveBeenCalledOnce();
    expect(menu.hidden).toBe(true);

    toolbar.element.querySelector<HTMLButtonElement>('[data-page-id="parent"] > button')?.click();
    expect(menu.querySelector('[data-desktop-breadcrumb-menu-heading]')?.textContent).toBe('Pages locales');
    expect(menu.querySelector('[data-desktop-breadcrumb-menu-children]')).not.toBeNull();
    menu.querySelector<HTMLButtonElement>('[data-desktop-breadcrumb-menu-children]')?.click();
    expect(menu.querySelector('[data-desktop-breadcrumb-menu-heading]')?.textContent).toBe('Nouvelle page');
    expect(menu.querySelector('[data-desktop-breadcrumb-menu-item="child"]')?.getAttribute('aria-current')).toBe('page');
    menu.querySelector<HTMLButtonElement>('[data-desktop-breadcrumb-menu-back]')?.click();
    expect(menu.querySelector('[data-desktop-breadcrumb-menu-heading]')?.textContent).toBe('Pages locales');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.hidden).toBe(true);
    toolbar.destroy();
  });
});

describe('breadcrumb navigation', () => {
  it('opens the page when an ancestor crumb is clicked, rather than its menu', () => {
    const open = vi.fn();
    const toolbar = createPageToolbar([{ id: 'p', title: 'Page' }], false, vi.fn());
    document.body.append(toolbar.element);
    // An ancestor carries both: a menu to jump sideways, and onOpen to go to it.
    // Notion goes to the page; the dropdown belongs to the workspace chip.
    toolbar.setBreadcrumbs([
      { id: 'parent', title: 'Bienvenue sur Blok', onOpen: open, menu: [{ id: 'sib', title: 'Autre', onOpen: vi.fn() }] },
      { id: 'current', title: 'Droits et partage', menu: [{ id: 'sib', title: 'Autre', onOpen: vi.fn() }] },
    ]);
    const crumbs = [...toolbar.element.querySelectorAll<HTMLButtonElement>('[data-desktop-page-breadcrumb-item] button')];
    const parent = crumbs.find((node) => node.textContent?.includes('Bienvenue'))!;
    parent.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(parent.getAttribute('aria-haspopup')).toBeNull();

    // The current page has nowhere to go, so its crumb keeps the menu.
    const current = crumbs.find((node) => node.textContent?.includes('Droits'))!;
    expect(current.getAttribute('aria-haspopup')).toBe('menu');
    toolbar.destroy();
  });
});

it('moves through page actions with the keyboard and restores focus on Escape', () => {
  const toolbar = createPageToolbar([{id:'page', title:'Page'}], false, vi.fn(), undefined, undefined, {
    onHistory: () => () => {}, onRename: vi.fn(),
  });
  document.body.append(toolbar.element);
  try {
    const trigger = toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-more]')!;
    trigger.click();
    const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true}));
    expect(document.activeElement?.getAttribute('role')).toBe('switch');
    press('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Historique des versions');
    press('End');
    expect(document.activeElement?.textContent).toBe('Renommer');
    press('Escape');
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  } finally { toolbar.destroy(); toolbar.element.remove(); }
});

describe('fil de la page', () => {
  it('ne nomme plus l’espace au-dessus de la page', () => {
    // Un fil nomme les parents d'une page. L'espace n'en est pas un : son nom
    // est déjà dans la barre latérale, et le répéter ici n'apprend rien. La
    // place reste libre pour un espace d'équipe, qui lui est un parent.
    const toolbar = createPageToolbar([{id: 'p', title: 'Nouvelle page'}], false, vi.fn());
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector('[data-desktop-page-workspace]')).toBeNull();
    expect(toolbar.element.textContent).toContain('Nouvelle page');
    toolbar.destroy();
  });

  it('garde le fil des parents quand la page en a', () => {
    const toolbar = createPageToolbar([{id: 'parent', title: 'Parent'}, {id: 'p', title: 'Enfant'}], false, vi.fn());
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector('[data-desktop-page-workspace]')).toBeNull();
    expect(toolbar.element.querySelector('nav')?.textContent).toContain('Parent');
    expect(toolbar.element.querySelector('[data-desktop-page-breadcrumb-separator]')?.textContent).toBe('/');
    toolbar.destroy();
  });
});

describe('où la page est enregistrée', () => {
  it('le dit dans le menu plutôt que dans la barre', () => {
    const toolbar = createPageToolbar([{id: 'p', title: 'Page'}], false, vi.fn(), undefined, undefined, {storedOnDevice: true});
    document.body.append(toolbar.element);
    // La barre du haut nomme la page ; où elle dort est une information de
    // second plan, qui n'a pas à occuper cette ligne en permanence.
    const identity = must(toolbar.element.querySelector('[data-desktop-page-identity]'));
    expect(identity.querySelector('[data-desktop-page-local]')).toBeNull();
    must(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-more]')).click();
    const badge = must(toolbar.element.querySelector('[data-desktop-page-menu] [data-desktop-page-local]'));
    expect(badge.textContent).toContain('Sur cet appareil');
    toolbar.destroy();
  });

  it('se tait pour une page qui vit sur un serveur', () => {
    const toolbar = createPageToolbar([{id: 'p', title: 'Page'}], false, vi.fn());
    document.body.append(toolbar.element);
    must(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-more]')).click();
    expect(toolbar.element.querySelector('[data-desktop-page-local]')).toBeNull();
    toolbar.destroy();
  });
});
