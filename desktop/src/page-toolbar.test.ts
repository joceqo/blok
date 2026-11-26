import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPageToolbar } from './page-toolbar';

beforeEach(() => vi.clearAllMocks());

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected toolbar element');
  return value;
}

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('page appearance toolbar', () => {
  /**
   * The "on this device" marker lost its label at this width and read as a dead
   * button among live ones. Where a page is stored is the save status's job.
   */
  it('carries no device marker among the actions', () => {
    const toolbar = createPageToolbar([{ id: 'p', title: 'Page' }], false, vi.fn());

    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector('[data-desktop-page-local]')).toBeNull();
    expect(toolbar.element.textContent).not.toContain('Sur cet appareil');
    toolbar.destroy();
  });

  it('copies the current page URL from the host and shows visible success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const toolbar = createPageToolbar([{ id: 'old', title: 'Old' }], false, vi.fn(), undefined, undefined, { pageUrl: id => `https://blok.example.com/?page=${id}` });
    document.body.append(toolbar.element);
    toolbar.setBreadcrumbs([{ id: 'current', title: 'Current' }]);
    const copy = required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-copy]'));
    copy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('https://blok.example.com/?page=current'));
    const status = required(toolbar.element.querySelector<HTMLElement>('[role="status"]'));
    expect(status.textContent).toBe('Lien copié'); expect(status.hidden).toBe(false);
    expect(copy.title).toBe('Lien copié');
    toolbar.destroy();
  });

  /**
   * On a row opened full page the last crumb names the ROW, so rebuilding
   * `?page=<id>` from it addressed a page that does not exist. The address bar
   * already holds the row's own url.
   */
  it('copies the row’s own address when a row is open full page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    history.replaceState(null, '', '/?page=host&row=row-one&database=db');
    const toolbar = createPageToolbar([{ id: 'host', title: 'Skills' }], false, vi.fn(), undefined, undefined, { pageUrl: id => `https://blok.example.com/?page=${id}` });

    document.body.append(toolbar.element);
    toolbar.setBreadcrumbs([{ id: 'host', title: 'Skills' }, { id: 'row-one', title: 'Documenter un dépôt' }]);
    required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-copy]')).click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('row=row-one')));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('page=host'));
    history.replaceState(null, '', '/');
    toolbar.destroy();
  });

  it('shows a failure instead of claiming success when clipboard access is refused', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    const toolbar = createPageToolbar([{ id: 'p', title: 'Page' }], false, vi.fn());
    document.body.append(toolbar.element);
    required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-copy]')).click();
    await vi.waitFor(() => expect(toolbar.element.querySelector('[role="status"]')?.textContent).toContain('Copie impossible'));
    expect(required(toolbar.element.querySelector<HTMLElement>('[role="status"]')).hidden).toBe(false);
    toolbar.destroy();
  });
  it('opens fresh workspace choices from its breadcrumb', () => {
    const onOpen = vi.fn();
    const workspacePages = vi.fn(() => [{ id: 'a', title: 'Guide', onOpen }]);
    const toolbar = createPageToolbar([{ id: 'a', title: 'Guide' }], false, vi.fn(), undefined, undefined, { workspaceName: 'Équipe', workspacePages });
    document.body.append(toolbar.element);
    required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-workspace]')).click();
    expect(workspacePages).toHaveBeenCalledOnce();
    required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-breadcrumb-menu-item="a"]')).click();
    expect(onOpen).toHaveBeenCalledOnce();
    toolbar.destroy();
  });
  it('refreshes workspace names and menu headings without rebuilding the page toolbar', () => {
    const toolbar = createPageToolbar([{id: 'p', title: 'Draft'}], false, vi.fn(), undefined, undefined, {
      workspaceName: 'Old name', workspacePages: () => [],
    });
    document.body.append(toolbar.element);
    const chip = required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-workspace]'));
    chip.click();
    toolbar.setWorkspaceName('Maison');
    expect(chip.title).toBe('Maison');
    expect(chip.textContent).toBe('Maison');
    chip.click();
    expect(toolbar.element.querySelector('[data-desktop-breadcrumb-menu-heading]')?.textContent).toBe('Maison');
    expect(toolbar.element.querySelector('[data-desktop-page-toolbar-title]')?.textContent).toBe('Draft');
    toolbar.destroy();
  });
  it('changes a page to full width and keeps the choice visible in the menu', () => {
    const onFullWidthChange = vi.fn();
    const toolbar = createPageToolbar([{ id: 'plan', title: 'Plan', icon: '🏈' }], false, onFullWidthChange);
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector('[data-desktop-page-toolbar-title]')?.textContent).toBe('Plan');
    required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-more]')).click();
    const choice = required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-full-width]'));
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

  it('goes to the page a crumb names, even the one already open, instead of listing siblings', () => {
    const openCurrent = vi.fn();
    const toolbar = createPageToolbar([
      { id: 'parent', title: 'Nouvelle page', icon: '🏕️', onOpen: vi.fn() },
      { id: 'current', title: 'Skills', icon: '🥲', menuHeading: 'Nouvelle page', onOpen: openCurrent, menu: [
        { id: 'current', title: 'Skills', icon: '🥲', current: true, onOpen: vi.fn() },
        { id: 'sibling', title: 'Autre page', onOpen: vi.fn() },
      ] },
    ], false, vi.fn());

    document.body.append(toolbar.element);
    const current = required(toolbar.element.querySelector<HTMLButtonElement>('[data-page-id="current"] > button'));

    current.click();
    expect(openCurrent).toHaveBeenCalledOnce();
    expect(current.getAttribute('aria-haspopup')).toBeNull();
    expect(toolbar.element.querySelector<HTMLElement>('[data-desktop-breadcrumb-menu]')?.hidden ?? true).toBe(true);
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
    const child = required(toolbar.element.querySelector<HTMLButtonElement>('[data-page-id="child"] > button'));

    child.click();
    const menu = required(toolbar.element.querySelector<HTMLElement>('[data-desktop-breadcrumb-menu]'));

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
    const parent = required(crumbs.find((node) => node.textContent?.includes('Bienvenue')));
    parent.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(parent.getAttribute('aria-haspopup')).toBeNull();

    // The current page has nowhere to go, so its crumb keeps the menu.
    const current = required(crumbs.find((node) => node.textContent?.includes('Droits')));
    expect(current.getAttribute('aria-haspopup')).toBe('menu');
    toolbar.destroy();
  });
});

it('opens the move destination flow from page actions and hides it in read-only mode', () => {
  const onMove = vi.fn();
  const toolbar = createPageToolbar([{ id: 'p', title: 'Page' }], false, vi.fn(), undefined, undefined, { onMove });
  document.body.append(toolbar.element);
  toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-more]')?.click();
  const move = [...toolbar.element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Déplacer vers…');
  expect(move).toBeDefined();
  move?.click();
  expect(onMove).toHaveBeenCalledOnce();
  expect(toolbar.element.querySelector<HTMLElement>('[data-desktop-page-menu]')?.hidden).toBe(true);
  toolbar.destroy();
  const readonly = createPageToolbar([{ id: 'p', title: 'Page' }], false, vi.fn(), undefined, undefined, { onMove, readOnly: true });
  expect([...readonly.element.querySelectorAll('button')].some(button => button.textContent === 'Déplacer vers…')).toBe(false);
  readonly.destroy();
});

it('opens version history after move and before trash in the page actions menu', () => {
  const onHistory = vi.fn();
  const toolbar = createPageToolbar([{id:'p',title:'Page'}],false,vi.fn(),undefined,undefined,{onMove:vi.fn(),onHistory,onDelete:vi.fn()});
  document.body.append(toolbar.element);
  toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-more]')?.click();
  const menu=toolbar.element.querySelector<HTMLElement>('[data-desktop-page-menu]');
  expect(menu?.getAttribute('aria-label')).toBe('Actions de la page');
  const commands=[...toolbar.element.querySelectorAll<HTMLButtonElement>('[data-desktop-page-command]')];
  expect(commands.map(node=>node.textContent)).toEqual(['Déplacer vers…','Historique des versions','Mettre à la corbeille']);
  commands[1]?.click();expect(onHistory).toHaveBeenCalledOnce();expect(menu?.hidden).toBe(true);toolbar.destroy();
});

it('filters page actions without accents and activates the result with the keyboard', () => {
  const onMove=vi.fn();
  const toolbar=createPageToolbar([{id:'p',title:'Page'}],false,vi.fn(),undefined,undefined,{onMove,onDuplicate:vi.fn(),onDelete:vi.fn()});
  document.body.append(toolbar.element);
  required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-more]')).click();
  const search=required(toolbar.element.querySelector<HTMLInputElement>('input[type="search"]'));
  expect(document.activeElement).toBe(search);
  search.value='deplacer'; search.dispatchEvent(new Event('input',{bubbles:true}));
  const commands=[...toolbar.element.querySelectorAll<HTMLButtonElement>('[data-desktop-page-command]')].filter(button=>!button.hidden);
  expect(commands.map(button=>button.textContent)).toEqual(['Déplacer vers…']);
  search.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  expect(document.activeElement).toBe(commands[0]);
  commands[0].click();
  expect(onMove).toHaveBeenCalledOnce();
  expect(required(toolbar.element.querySelector<HTMLElement>('[data-desktop-page-menu]')).hidden).toBe(true);
  toolbar.destroy();
});

it('copies from the action menu in read-only mode and shows an empty search without enabling edits', async () => {
  const writeText=vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
  const toolbar=createPageToolbar([{id:'p',title:'Page'}],false,vi.fn(),undefined,undefined,{readOnly:true,pageUrl:()=> 'https://blok.example/p/page',onDelete:vi.fn()});
  document.body.append(toolbar.element);
  const more=required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-more]'));
  more.click();
  expect(toolbar.element.querySelector('[data-danger]')).toBeNull();
  expect(required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-full-width]')).disabled).toBe(true);
  const search=required(toolbar.element.querySelector<HTMLInputElement>('input[type="search"]'));
  search.value='introuvable'; search.dispatchEvent(new Event('input',{bubbles:true}));
  expect(required(toolbar.element.querySelector<HTMLElement>('[data-desktop-page-menu-empty]')).hidden).toBe(false);
  more.click(); more.click();
  expect(search.value).toBe('');
  required(toolbar.element.querySelector<HTMLButtonElement>('[data-desktop-page-copy-action]')).click();
  await vi.waitFor(()=>expect(writeText).toHaveBeenCalledWith('https://blok.example/p/page'));
  expect(document.activeElement).toBe(more);
  toolbar.destroy();
});
