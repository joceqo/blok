import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {must} from './test-helpers';
import {revealSetting} from './settings-search';
import { WORKSPACE_ROLES } from './access-vocabulary';
import { rememberWorkspace, workspaceKey, type RemoteWorkspace } from './workspace-registry';
import { applyAppearance, createDesktopFooter, readAppearance } from './settings';

const childUi = vi.hoisted(() => ({
  destroy: vi.fn(), refresh: vi.fn(async () => undefined),
  mount: vi.fn(), invite: vi.fn(),
}));
vi.mock('./cloud/workspace-settings', () => ({
  mountWorkspaceMembers: childUi.mount, openWorkspaceInvitation: childUi.invite,
}));
beforeEach(() => {
  vi.clearAllMocks();
  childUi.mount.mockReturnValue({destroy: childUi.destroy, refresh: childUi.refresh});
});
afterEach(() => {
  document.querySelector<HTMLButtonElement>('[data-desktop-settings-close]')?.click();
  document.body.innerHTML = '';
  document.body.removeAttribute('data-blok-theme');
  document.documentElement.removeAttribute('data-blok-theme');
  localStorage.clear();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('desktop sidebar footer', () => {
  it('opens preferences and saves the selected appearance', () => {
    const root = document.createElement('div');
    root.setAttribute('data-desktop-shell', '');
    document.body.append(root);
    applyAppearance(root, readAppearance());
    const onThemeChange = vi.fn();
    const footer = createDesktopFooter(onThemeChange);
    root.append(footer);
    expect(footer.querySelector('[data-inbox-trigger]')).toBeNull();

    const switcher = footer.querySelector('[data-desktop-switcher]') as HTMLButtonElement;
    switcher.click();
    expect(switcher.getAttribute('aria-expanded')).toBe('true');
    expect(footer.querySelector('[role="menu"]')?.hasAttribute('hidden')).toBe(false);

    const preferences = must([...footer.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Paramètres')));
    preferences.click();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.parentElement?.hasAttribute('hidden')).toBe(false);
    const theme = dialog.querySelector('[data-desktop-settings-theme]') as HTMLButtonElement;
    theme.click();
    must(document.querySelector<HTMLElement>('[data-blok-item-name=light]')).click();
    expect(readAppearance()).toBe('light');
    expect(root.getAttribute('data-blok-theme')).toBe('light');
    expect(document.body.getAttribute('data-blok-theme')).toBe('light');
    expect(onThemeChange).toHaveBeenCalledWith('light');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dialog.parentElement?.hasAttribute('hidden')).toBe(true);
  });

  it('presents the embedded identity as a device profile and asks for a distant server by choice', async () => {
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke: vi.fn().mockResolvedValue(null)});
    const footer = createDesktopFooter(vi.fn(), {kind:'remote',embedded:true,device:true,id:'my-id',name:'Mes documents',workspaceId:'local',
      server:'http://127.0.0.1:53002',accountId:'local-user',userName:'Profil local',role:'admin'});
    document.body.append(footer);
    const change = vi.fn(); footer.addEventListener('blok:desktop-connect-cloud', change);
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]')).click();
    expect(footer.textContent).toContain('Se connecter à un serveur distant');
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-menu-account]')).click();
    const dialog = must(document.querySelector<HTMLElement>('[role=dialog]'));
    expect(dialog.querySelector('[data-desktop-settings-title]')?.textContent).toBe('Profil local');
    expect(dialog.textContent).not.toContain('Adresse e-mail');
    must([...dialog.querySelectorAll<HTMLButtonElement>('[data-desktop-settings-nav-item]')].find(el=>el.textContent==='Connexions')).click();
    must([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(el=>el.textContent==='Se connecter à un serveur distant')).click();
    expect(change).toHaveBeenCalledWith(expect.objectContaining({detail:{section:'account'}}));
  });

  it('opens the Docker server through native connections without changing the standalone workspace', async () => {
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke: vi.fn().mockResolvedValue('/tmp/workspace')});
    const footer = createDesktopFooter(vi.fn());
    document.body.append(footer);
    const change = vi.fn();
    footer.addEventListener('blok:desktop-connect-cloud', change);
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]')).click();
    must([...footer.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(el => el.textContent === 'Paramètres')).click();
    must([...document.querySelectorAll<HTMLButtonElement>('[data-desktop-settings-nav-item]')].find(el => el.textContent === 'Connexions')).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Ouvrir le serveur local'));
    must([...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === 'Ouvrir le serveur local')).click();
    expect(change).toHaveBeenCalledWith(expect.objectContaining({detail:{section:'local-server'}}));
  });

  it('shows a local profile and AI provider settings', async () => {
    const root = document.createElement('div');
    root.setAttribute('data-desktop-shell', '');
    document.body.append(root);
    const footer = createDesktopFooter(() => undefined);
    root.append(footer);
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]')).click();
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-menu-account]')).click();
    const dialog = must(document.querySelector<HTMLElement>('[data-desktop-settings-dialog]'));
    expect(dialog.querySelector('[data-desktop-settings-title]')?.textContent).toBe('Profil local');
    const name = must(dialog.querySelector<HTMLInputElement>('[data-desktop-settings-name]'));
    name.value = 'Mes notes';
    name.dispatchEvent(new Event('change'));
    expect(footer.querySelector('[data-desktop-switcher-name]')?.textContent).toBe('Mes notes');
    const accountTab = must(dialog.querySelector<HTMLButtonElement>('[data-settings-tab="account"]'));
    expect(accountTab.textContent).toBe('Mes notes');
    expect(accountTab.querySelector<HTMLElement>('[data-settings-profile-avatar]')?.dataset.initial).toBe('M');
    must([...dialog.querySelectorAll<HTMLButtonElement>('[data-desktop-settings-nav-item]')]
      .find((item) => item.textContent?.includes('Assistant IA'))).click();
    expect(dialog.querySelectorAll('[data-desktop-settings-provider-status]')).toHaveLength(0);
    expect(dialog.textContent).toContain('Configurez OpenAI');
    expect(dialog.querySelector('[data-desktop-settings-title]')?.textContent).toBe('Assistant IA');
  });
});

const remoteRef: RemoteWorkspace = {kind:'remote',id:'team',name:'Acme',server:'http://localhost:1420',accountId:'user',userName:'member@example.org',workspaceId:'acme',role:'admin'};
function remoteFooter(role: 'admin'|'member'|'viewer' = 'admin'): HTMLElement {
  const ref = {...remoteRef,role}; rememberWorkspace(ref);
  localStorage.setItem('blok:desktop:active-workspace:v1',workspaceKey(ref));
  const footer=createDesktopFooter(()=>undefined);document.body.append(footer);
  must(footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]')).click();
  return footer;
}
describe('workspace menu hierarchy',()=>{
  it('opens member settings on the access requests tab from an admin notification', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async resource => {
      const data = String(resource).endsWith('/notifications')
        ? {notifications:[{id:'1', type:'join_requested', actorName:'Alex', createdAt:'2026-11-01T12:00:00Z', readAt:null}], unreadCount:1}
        : {user:{id:'user',email:'admin@example.test'},workspaces:[]};
      return new Response(JSON.stringify(data));
    });
    try {
      const header = document.createElement('div');
      const create = document.createElement('button');
      create.textContent = 'Nouvelle page';
      header.append(create);
      const footer = createDesktopFooter(() => undefined, remoteRef, header);
      document.body.append(header, footer);
      expect(footer.querySelector('[data-inbox-trigger]')).toBeNull();
      const inbox = must(header.querySelector<HTMLButtonElement>('[data-inbox-trigger]'));
      expect(inbox.nextElementSibling).toBe(create);
      inbox.click();
      await vi.waitFor(() => expect(document.querySelector('[data-inbox-pane]')?.textContent).toContain('Alex'));
      must([...document.querySelectorAll<HTMLButtonElement>('[data-inbox-pane] button')].find(b => b.textContent === 'Voir les demandes')).click();
      expect(childUi.mount).toHaveBeenCalledWith(expect.any(HTMLElement),expect.objectContaining({slug:'acme',initialTab:'requests'}));
    } finally { fetch.mockRestore(); }
  });
  it('shows three primary admin actions and account-grouped workspaces without browser local data controls',()=>{
    const footer=remoteFooter();const menu=must(footer.querySelector('[data-desktop-footer-menu]'));
    const primary=[...menu.children].filter((node)=>node.hasAttribute('data-desktop-menu-item'));
    // The identity header is separately styled; command rows follow it.
    expect(primary.map(node=>node.textContent)).toEqual(['Paramètres','Inviter des membres','Ajouter un compte']);
    expect(menu.textContent).not.toContain('localhost');
    expect(menu.textContent).not.toContain('Créer un espace local');
    expect(menu.textContent).not.toContain('Copier le chemin');
    expect(menu.querySelector('[aria-label="Sur cet appareil"]')).toBeNull();
    expect(menu.querySelector('[role="menuitemradio"][aria-current="true"]')?.textContent).toContain('Acme');
  });
  it('opens settings, members and identity in place, and connects a new account through the chooser',()=>{
    const footer=remoteFooter();const events: unknown[]=[];const href=location.href;
    footer.addEventListener('blok:desktop-connect-cloud',(event)=>events.push((event as CustomEvent).detail));
    must([...footer.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node=>node.textContent==='Paramètres')).click();
    expect(document.querySelector('[data-desktop-settings-theme]')).not.toBeNull();
    expect(footer.inert || footer.hasAttribute('inert')).toBe(true);
    expect(location.href).toBe(href); expect(events).toEqual([]);
    must(document.querySelector<HTMLButtonElement>('[data-desktop-settings-close]')).click();
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-menu-invite]')).click();
    expect(childUi.invite).toHaveBeenCalledWith(expect.objectContaining({slug:'acme'}));
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-menu-account]')).click();
    const dialog=must(document.querySelector<HTMLElement>('[data-desktop-settings-dialog]'));
    expect(dialog.querySelector('[data-desktop-settings-title]')?.textContent).toBe('Mon compte');
    expect(dialog.querySelector('[data-desktop-settings-content]')?.textContent).toContain('member@example.org');
    expect(dialog.querySelector('[data-desktop-settings-nav-item][aria-current="page"]')?.textContent).toBe('member@example.org');
    expect(location.href).toBe(href); expect(events).toEqual([]);
    must([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='Comptes et espaces')).click();
    expect(events).toEqual([{section:'account'}]);
  });
  it('reuses the members panel, nests invitations inside the settings modal, and tears down the panel on close',()=>{
    const footer=remoteFooter();
    must([...footer.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node=>node.textContent==='Paramètres')).click();
    const dialog=must(document.querySelector<HTMLElement>('[data-desktop-settings-dialog]'));
    must([...dialog.querySelectorAll<HTMLButtonElement>('[data-desktop-settings-nav-item]')].find(node=>node.textContent==='Membres')).click();
    expect(childUi.mount).toHaveBeenCalledWith(expect.any(HTMLElement),expect.objectContaining({slug:'acme'}));
    const mounted = must(childUi.mount.mock.calls[0]) as unknown as [HTMLElement, { onInvite: () => void }];
    mounted[1].onInvite();
    expect(childUi.invite).toHaveBeenLastCalledWith(expect.objectContaining({container:dialog}));
    must(dialog.querySelector<HTMLButtonElement>('[data-desktop-settings-close]')).click();
    expect(childUi.destroy).toHaveBeenCalledOnce();
    expect(footer.hasAttribute('inert')).toBe(false);
  });
  it('shows actual account identity and role without an editable workspace-name masquerading as a profile',()=>{
    const footer=remoteFooter();
    must([...footer.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node=>node.textContent==='Paramètres')).click();
    const dialog=must(document.querySelector<HTMLElement>('[data-desktop-settings-dialog]'));
    must([...dialog.querySelectorAll<HTMLButtonElement>('[data-desktop-settings-nav-item]')].find(node=>node.textContent==='member@example.org')).click();
    expect(dialog.querySelector('[data-desktop-settings-content]')?.textContent).toContain('member@example.org');
    expect(dialog.querySelector('[data-desktop-settings-content]')?.textContent).toContain(WORKSPACE_ROLES.admin);
    expect(dialog.querySelector('[data-desktop-settings-name]')).toBeNull();
  });
  it.each(['member','viewer'] as const)('keeps invitations out of the %s menu and opens appearance preferences',role=>{
    const footer=remoteFooter(role);
    expect(footer.querySelector('[data-desktop-menu-invite]')).toBeNull();
    must([...footer.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node=>node.textContent==='Paramètres')).click();
    expect(document.querySelector('[data-desktop-settings-theme]')).not.toBeNull();
    expect(document.querySelector('[data-desktop-settings-path]')).toBeNull();
  });
  it.each([true, false])('reports the actual hosting location in general settings (embedded=%s)', embedded => {
    const workspace = {...remoteRef, embedded};
    const footer = createDesktopFooter(() => undefined, workspace);
    document.body.append(footer);
    footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', {detail: 'general'}));
    const panel = must(document.querySelector<HTMLElement>('[data-desktop-settings-content]'));
    expect(panel.dataset.settingsSource).toBe('desktop/src/settings-panels.tsx');
    expect(panel.querySelector('h1')?.textContent).toBe('Général');
    expect(panel.textContent).toContain(workspace.name);
    expect(panel.querySelector('[data-desktop-settings-version]')?.textContent).toMatch(/Blok .+ · App .+/);
    if (embedded) {
      expect(panel.textContent).toContain('Sur cet appareil');
      expect(panel.textContent).not.toContain(workspace.server);
    } else {
      expect(panel.querySelector('details')?.textContent).toContain(workspace.server);
    }
  });
  it('keeps local workspaces in a separate native group and puts paths inside advanced preferences',()=>{
    Reflect.set(window,'__TAURI_INTERNALS__',{invoke:vi.fn().mockResolvedValue('/test/workspace')});
    const footer=createDesktopFooter(()=>undefined);document.body.append(footer);
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]')).click();
    expect(footer.querySelector('[aria-label="Sur cet appareil"] [data-desktop-menu-new-workspace]')).not.toBeNull();
    expect(footer.querySelector('[data-desktop-footer-menu]')?.textContent).not.toContain('Copier le chemin');
    must([...footer.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node=>node.textContent==='Paramètres')).click();
    expect(document.querySelector('details [data-desktop-settings-path]')).not.toBeNull();
  });
});

describe('help menu', () => {
  it('opens help from its own footer button', () => {
    const footer = remoteFooter('member');
    const help = footer.querySelector<HTMLButtonElement>('[data-desktop-footer-action="help"]');
    expect(help).toBeTruthy();
    must(help).click();
    const popover = document.querySelector('[data-desktop-help-popover], [data-blok-popover]');
    expect(popover?.textContent).toMatch(/Premiers pas/);
    expect(popover?.textContent).toMatch(/Qui peut voir quoi/);
    expect(popover?.textContent).toMatch(/Raccourcis/);
    expect(popover?.textContent).toMatch(/Blok /);
    // No address to write to, so no row: a permanently greyed entry reads as broken.
    expect(popover?.textContent).not.toMatch(/Signaler un problème/);
  });

  it('keeps focus on the trigger for a pointer and lets keyboard users browse the menu', () => {
    const footer = createDesktopFooter(vi.fn());
    document.body.append(footer);
    const trigger = must(footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]'));
    const prefs = must(footer.querySelector<HTMLButtonElement>('[data-desktop-menu-preferences]'));
    trigger.focus();
    trigger.dispatchEvent(new MouseEvent('click', {bubbles:true, detail:1}));
    expect(document.activeElement).toBe(trigger);
    expect(prefs.title).toBe('');
    trigger.dispatchEvent(new KeyboardEvent('keydown', {bubbles:true, key:'Escape'}));
    trigger.dispatchEvent(new KeyboardEvent('keydown', {bubbles:true, key:'ArrowDown'}));
    expect(document.activeElement).toBe(prefs);
    prefs.dispatchEvent(new KeyboardEvent('keydown', {bubbles:true, key:'Tab'}));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('exposes working destinations in the footer and reserves trash for server-backed spaces', () => {
    const footer = remoteFooter();
    const library = vi.fn(); const trash = vi.fn();
    footer.addEventListener('blok:desktop-open-library', library);
    footer.addEventListener('blok:desktop-open-trash', trash);
    const open = must(footer.querySelector<HTMLButtonElement>('[data-desktop-footer-action="destinations"]'));
    open.click();
    must(document.querySelector<HTMLElement>('[data-blok-item-name=library]')).click();
    expect(library).toHaveBeenCalledOnce();
    open.click();
    must(document.querySelector<HTMLElement>('[data-blok-item-name=trash]')).click();
    expect(trash).toHaveBeenCalledOnce();
    const local = createDesktopFooter(vi.fn(), {kind:'local', id:'local', name:'Local'});
    document.body.append(local);
    must(local.querySelector<HTMLButtonElement>('[data-desktop-footer-action="destinations"]')).click();
    expect([...document.querySelectorAll('[data-desktop-destinations-popover]')].at(-1)?.querySelector('[data-blok-item-name=trash]')).toBeNull();
  });
  it('offers the report row only once the instance names a support address, never the viewer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ user: { id: 'u1', email: 'moi@example.test' }, workspaces: [], supportEmail: 'ops@example.test' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const footer = remoteFooter('member');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const help = footer.querySelector<HTMLButtonElement>('[data-desktop-footer-action="help"]');
    must(help).click();
    const popover = document.querySelector('[data-desktop-help-popover], [data-blok-popover]');
    expect(popover?.textContent).toMatch(/Signaler un problème/);
    expect(popover?.textContent).not.toMatch(/moi@example\.test/);
    vi.unstubAllGlobals();
  });
});

describe('settings discovery', () => {
  it('finds connections by MCP and opens account sign-in from a local workspace', () => {
    const footer = createDesktopFooter(() => undefined); document.body.append(footer);
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]')).click();
    must([...footer.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(node => node.textContent === 'Paramètres')).click();
    const search = must(document.querySelector<HTMLInputElement>('[data-desktop-settings-search]'));
    search.value = 'MCP'; search.dispatchEvent(new Event('input'));
    const visible = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-results] button')];
    expect(visible.map(node => node.querySelector('strong')?.textContent)).toEqual(['Connexions']);
    search.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'}));
    expect(document.querySelector('[data-desktop-settings-title]')?.textContent).toBe('Connexions');
    const connect = vi.fn(); footer.addEventListener('blok:desktop-connect-cloud', connect);
    must([...document.querySelectorAll<HTMLButtonElement>('[data-desktop-connections-accounts] button')].find(node => node.textContent === 'Se connecter')).click();
    expect(connect).toHaveBeenCalledOnce();
  });
  it('browses filtered sections by keyboard and returns focus to the shortcut origin', () => {
    const footer = createDesktopFooter(vi.fn());
    const opener = document.createElement('button');
    document.body.append(footer, opener);
    opener.focus();
    footer.dispatchEvent(new Event('blok:desktop-open-preferences'));
    const search = must(document.querySelector<HTMLInputElement>('[data-desktop-settings-search]'));
    search.focus();
    search.value = 'sombre   THEME'; search.dispatchEvent(new Event('input'));
    search.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
    expect(document.activeElement?.querySelector('strong')?.textContent).toBe('Thème');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(search.value).toBe('');
    expect(document.activeElement).toBe(search);
    search.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
    expect(document.activeElement?.getAttribute('data-settings-tab')).toBe('account');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true}));
    expect(document.activeElement).toBe([...document.querySelectorAll('[data-desktop-settings-nav-item]:not([hidden])')].at(-1));
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(document.activeElement).toBe(opener);
  });
  it('offers no e-mail notification settings without a server to send them', () => {
    // A local workspace has no service behind it: an "Activité dans mon espace
    // de travail" switch would promise mail nobody can send.
    const footer = createDesktopFooter(vi.fn());
    document.body.append(footer);
    footer.dispatchEvent(new Event('blok:desktop-open-preferences'));
    const tabs = [...document.querySelectorAll('[data-desktop-settings-nav] button')]
      .map(node => node.textContent?.trim());
    expect(tabs).not.toContain('Notifications');
    const search = must(document.querySelector<HTMLInputElement>('[data-desktop-settings-search]'));
    search.value = 'e-mail';
    search.dispatchEvent(new Event('input'));
    const results = [...document.querySelectorAll('[data-settings-results] button')]
      .map(node => node.querySelector('strong')?.textContent);
    expect(results).not.toContain('Modifications de pages');
    expect(results).not.toContain('Activité dans mon espace de travail');
  });

  it('reveals the matched control in another panel without activating it', () => {
    const footer = createDesktopFooter(vi.fn());
    document.body.append(footer);
    footer.dispatchEvent(new Event('blok:desktop-open-preferences'));
    const search = must(document.querySelector<HTMLInputElement>('[data-desktop-settings-search]'));
    search.value = 'favoris';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelector('[data-desktop-settings-title]')?.textContent).toBe('Préférences');
    expect(document.querySelector('[data-settings-results] section')?.getAttribute('aria-label')).toBe('Espace de travail / Barre latérale');
    search.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(search.value).toBe('');
    expect(document.querySelector('[data-desktop-settings-title]')?.textContent).toBe('Barre latérale');
    const row = must(document.querySelector('[data-setting="favorites"][data-settings-highlight]'));
    expect(document.activeElement).toBe(row.querySelector('[role="switch"]'));
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
  });

  it('finds an e-mail notification switch from the search and reveals it in the notifications panel', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({notifications: [], unreadCount: 0})));
    try {
    const footer = createDesktopFooter(() => undefined, remoteRef);
    document.body.append(footer);
    footer.dispatchEvent(new Event('blok:desktop-open-preferences'));
    const search = must(document.querySelector<HTMLInputElement>('[data-desktop-settings-search]'));
    search.value = 'modifications de pages';
    search.dispatchEvent(new Event('input'));
    const visible = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-results] button')];
    expect(visible.map(node => node.querySelector('strong')?.textContent)).toEqual(['Modifications de pages']);
    search.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(document.querySelector('[data-desktop-settings-title]')?.textContent).toBe('Notifications');
    const row = must(document.querySelector('[data-setting="email-page-updates"][data-settings-highlight]'));
    expect(row.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    } finally { fetch.mockRestore(); }
  });

  it('excludes unavailable settings without fetching other panels while typing', () => {
    const footer = createDesktopFooter(vi.fn(), {kind: 'local', id: 'local', name: 'Local'});
    document.body.append(footer);
    footer.dispatchEvent(new Event('blok:desktop-open-preferences'));
    const fetch = vi.spyOn(window, 'fetch');
    try {
      const search = must(document.querySelector<HTMLInputElement>('[data-desktop-settings-search]'));
      for (const query of ['inscription', 'notification test', 'markdown']) {
        search.value = query;
        search.dispatchEvent(new Event('input'));
        expect(document.querySelector('[data-settings-results] button')).toBeNull();
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('focuses a delayed result and cancels the jump when the user moves on', async () => {
    const main = document.createElement('main');
    const input = document.createElement('input');
    document.body.append(main);
    const first = new AbortController();
    revealSetting(main, 'input', first.signal);
    main.append(input);
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
    first.abort();

    const second = new AbortController();
    revealSetting(main, 'button', second.signal);
    second.abort();
    input.focus();
    main.append(document.createElement('button'));
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
  });

  it('clears a search with Escape without closing settings and resets it on reopen', () => {
    const footer = createDesktopFooter(() => undefined); document.body.append(footer);
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]')).click();
    const open = must([...footer.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(node => node.textContent === 'Paramètres'));
    open.click();
    const search = must(document.querySelector<HTMLInputElement>('[data-desktop-settings-search]'));
    search.value = 'introuvable'; search.dispatchEvent(new Event('input'));
    expect(must(document.querySelector<HTMLElement>('[data-desktop-settings-no-results]')).hidden).toBe(false);
    search.focus();
    search.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
    expect(search.value).toBe('');
    expect(must(document.querySelector<HTMLElement>('[data-desktop-settings-overlay]')).hidden).toBe(false);
    must(document.querySelector<HTMLButtonElement>('[data-desktop-settings-close]')).click();
    open.click();
    expect(must(document.querySelector<HTMLElement>('[data-desktop-settings-no-results]')).hidden).toBe(true);
  });
});
