import {shellText} from './shell-i18n';
import type {SupportedLocale} from '../../types/configs/i18n-config';
import {findSettings, revealSetting, settingsCatalog, type SettingsPanel, type SettingsTab} from './settings-search';
import {mountSettingsSearchResults} from './settings-search-results';
import { footerIconPaths } from './components/shell/footer-icon-paths';
import { mountSidebarInbox } from './sidebar/sidebar-inbox';
import { mountFooterSurface, type FooterChoices } from './sidebar/sidebar-footer';
import { createSidebarPreferences, type SidebarPreferences } from '../../src/shell/sidebar-preferences';
import { IconBell, IconBuilding, IconCalendar, IconLibrary, IconDownload, IconSidebarRight, IconSliders, IconTrash } from '../../src/components/icons';
import {mountShellNavigationSettings} from './shell-navigation-settings';
import {mountCalendarImportSettings} from './settings-calendar-import';
import {openTeamspaces, type TeamPageNavigation} from './cloud/teamspaces';
import { showShortcutsDialog } from './shortcuts-dialog';
import { WORKSPACE_ROLES } from './access-vocabulary';
import { styleTextField, wrapSearchField } from './components/dom';
import { openModalDialog, type ModalDialogHandle } from '@blok/modal-dialog';
import { PopoverDesktop } from '@blok/popover';
import { CloudClient } from './cloud/client';
import { embeddedServerAvailable } from './native-runtime';
import { nativeSessionAdapter } from './native-session';
import { createNotificationTrigger } from './cloud/notification-trigger';
import { mountWorkspaceMembers, openWorkspaceInvitation } from './cloud/workspace-settings';
import {canCreateWorkspace, hasWebAccount, type WebAccountAction} from './cloud/web-account-actions';
import { activeWorkspace, listWorkspaces, createLocalWorkspace, workspaceKey, rememberWorkspace, LOCAL_SERVER_ORIGIN } from './workspace-registry';
import { dataDirectory } from './storage';
import corePackage from '../../package.json';
import appPackage from '../package.json';
import { mountSettingsPanel } from './settings-panels';
import { mountAiSettings } from './ai-settings';
import { mountCustomEmojiSettings } from './custom-emoji-settings';
import { mountWorkspaceBackup } from './workspace-backup';
import { mountMcpSettings } from './mcp-settings';
import {loadReactGrab, reactGrabAvailable} from './react-grab';
import { mountInstanceSettings, type InstancePanel } from './instance/instance-settings';
import { welcomePageId, welcomeRightsPageId } from './welcome-seed';

export type Appearance = 'dark' | 'light' | 'auto';

const KEY = 'blok:desktop:appearance';
const CORE_VERSION = corePackage.version;
const APP_VERSION = appPackage.version;

export function readAppearance(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'dark' || value === 'light' || value === 'auto' ? value : 'dark';
  } catch {
    return 'dark';
  }
}

function resolved(mode: Appearance): 'dark' | 'light' {
  if (mode !== 'auto') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function settingsPanelSource(panel: string): string {
  if (panel === 'account' || panel === 'preferences' || panel === 'general') return 'settings-panels.tsx';
  if (panel === 'emojis') return 'custom-emoji-settings.ts';
  if (panel === 'backups') return 'workspace-backup.ts';
  if (panel === 'mcp') return 'mcp-settings.ts';
  if (panel === 'calendar' || panel === 'import') return 'settings-calendar-import.tsx';
  if (panel === 'sidebar' || panel === 'notifications') return 'shell-navigation-settings.tsx';
  if (panel === 'teams') return 'cloud/teamspaces.ts';
  if (panel === 'ai') return 'ai-settings.ts';
  if (panel === 'members') return 'cloud/workspace-settings.ts';
  if (panel.startsWith('instance-')) return 'instance/instance-settings.ts';
  return 'settings.ts';
}

function openLocalWorkspaceDialog(onCreate: (name: string) => void): void {
  const overlay = el('div', 'data-desktop-settings-overlay');
  const surface = el('section', 'data-desktop-shortcuts-surface');
  surface.append(el('h2', 'data-desktop-settings-title', shellText("Nouvel espace local")));
  const form = document.createElement('form');
  const name = el('input', 'data-desktop-settings-name');
  name.type = 'text';
  styleTextField(name);
  name.placeholder = shellText("Nom de l’espace");
  name.setAttribute('aria-label', shellText("Nom de l’espace"));
  name.required = true;
  name.maxLength = 80;
  const actions = el('div', 'data-desktop-account-actions');
  const cancel = el('button', 'data-desktop-settings-copy', shellText("Annuler"));
  cancel.type = 'button';
  const submit = el('button', 'data-desktop-settings-copy', shellText("Créer"));
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(name, actions);
  surface.append(form);
  overlay.append(surface);
  const handle = openModalDialog({
    content: overlay,
    surface,
    label: shellText("Nouvel espace local"),
    initialFocus: () => name,
    onDismiss: () => handle.close(),
  });
  cancel.addEventListener('click', () => handle.close());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = name.value.trim();
    if (!value) return;
    handle.close();
    onCreate(value);
  });
}

export function applyAppearance(root: HTMLElement, mode: Appearance): void {
  const value = resolved(mode);
  root.setAttribute('data-blok-theme', value);
  document.body.setAttribute('data-blok-theme', value);
  if (mode === 'auto') document.documentElement.removeAttribute('data-blok-theme');
  else document.documentElement.setAttribute('data-blok-theme', mode);
}

export function watchSystemAppearance(root: HTMLElement): void {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query) return;
  query.addEventListener('change', () => {
    if (readAppearance() === 'auto') applyAppearance(root, 'auto');
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attr: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.setAttribute(attr, '');
  if (text !== undefined) node.textContent = text;
  return node;
}

function chevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm4 6 4 4 4-4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

type MenuIcon = 'profile' | 'settings' | 'ai' | 'storage' | 'connections' | 'emoji' | 'help' | 'apps' | 'people' | 'add';

function menuIcon(kind: MenuIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', footerIconPaths[kind]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function actionButton(attribute: string, label: string, kind: MenuIcon): HTMLButtonElement {
  const button = el('button', attribute);
  button.type = 'button';
  button.append(menuIcon(kind), el('span', 'data-desktop-action-label', label));
  button.title = label;
  return button;
}

interface FooterOptions {
  flushForBackup?: () => Promise<void>;
  onLanguageChange?: (language: SupportedLocale) => Promise<void>;
  footerHost?: HTMLElement;
  client?: CloudClient;
  signal?: AbortSignal;
  sidebarPreferences?: SidebarPreferences;
  teamPages?: TeamPageNavigation;
  importMarkdown?: (file:File)=>Promise<void>;
}
export function createDesktopFooter(onThemeChange: (mode: Appearance) => void, currentWorkspace = activeWorkspace(), headerActions?: HTMLElement, options: FooterOptions = {}): HTMLElement {
  const native = '__TAURI_INTERNALS__' in window;
  const onDevice = currentWorkspace.kind === 'remote' && currentWorkspace.embedded === true;
  const offlineProfile = native && (onDevice || currentWorkspace.kind === 'local');
  const admin = currentWorkspace.kind === 'remote' && currentWorkspace.role === 'admin';
  const client = currentWorkspace.kind === 'remote' ? options.client ?? new CloudClient({origin: currentWorkspace.server, sessionAdapter: native ? nativeSessionAdapter(currentWorkspace.server) : undefined}) : null;
  const ui = {
    members: null as ReturnType<typeof mountWorkspaceMembers> | null,
    instancePanel: null as ReturnType<typeof mountInstanceSettings> | null,
    modal: null as ModalDialogHandle | null,
    choices: [] as Array<{destroy(): void}>,
    panelGeneration: 0,
    footerPopup: null as PopoverDesktop | null,
    supportEmail: null as string | null,
  };
  const openInvitation = (container?: HTMLElement): {close(): void} | undefined => {
    if (!admin || !client || currentWorkspace.kind !== 'remote') return;
    if (!container) focusSwitcher();
    return openWorkspaceInvitation({client, slug: currentWorkspace.workspaceId, workspaceName: currentWorkspace.name, container, onComplete: () => ui.members?.refresh()});
  };
  const footer = options.footerHost ?? el('div', 'data-desktop-footer');
  const context = offlineProfile || currentWorkspace.kind === 'local' ? shellText("Sur cet appareil") : WORKSPACE_ROLES[currentWorkspace.role ?? 'member'];
  let reactSurface: ReturnType<typeof mountFooterSurface> | undefined;
  const legacy = options.footerHost ? undefined : legacyFooterSurface();
  const focusSwitcher = () => legacy ? legacy.switcher.focus() : reactSurface?.focus();
  function legacyFooterSurface() {
    const switcher = el('button', 'data-desktop-switcher');
    switcher.type = 'button';
    switcher.setAttribute('aria-label', shellText("Espace local et réglages"));
    switcher.setAttribute('aria-haspopup', 'menu');
    switcher.setAttribute('aria-expanded', 'false');
    const avatar = el('span', 'data-desktop-avatar', Array.from(currentWorkspace.name)[0]?.toLocaleUpperCase() || 'B');
    avatar.setAttribute('aria-hidden', 'true');
    switcher.append(avatar, el('span', 'data-desktop-switcher-name', shellText("Espace local")), chevron());
    footer.append(switcher);
    const menu = el('div', 'data-desktop-footer-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const account = el('button', 'data-desktop-menu-account');
    account.type = 'button'; account.setAttribute('role', 'menuitem');
    const menuAvatar = el('span', 'data-desktop-menu-avatar', currentWorkspace.name.charAt(0).toLocaleUpperCase());
    menuAvatar.setAttribute('aria-hidden', 'true');
    account.append(menuAvatar);
    const accountText = el('span', 'data-desktop-menu-account-text');
    accountText.append(el('strong', 'data-desktop-menu-title', currentWorkspace.name),
      el('small', 'data-desktop-menu-context', context));
    account.append(accountText);
    const preferences = actionButton('data-desktop-menu-item', shellText("Paramètres"), 'settings');
    preferences.setAttribute('role', 'menuitem');
    preferences.setAttribute('data-desktop-menu-preferences', '');
    preferences.removeAttribute('title');
    const quickHelp = document.createElement('button');
    quickHelp.setAttribute('data-desktop-footer-action', 'help');
    quickHelp.type = 'button';
    quickHelp.setAttribute('aria-label', shellText("Aide et raccourcis"));
    quickHelp.title = shellText("Aide et raccourcis");
    quickHelp.setAttribute('aria-haspopup', 'menu');
    quickHelp.append(menuIcon('help'));
    footer.append(quickHelp);
    const destinations = document.createElement('button');
    destinations.setAttribute('data-desktop-footer-action', 'destinations');
    destinations.type = 'button';
    destinations.setAttribute('aria-label', shellText("Autres vues de l’espace"));
    for (const trigger of [quickHelp, destinations]) {
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', 'false');
    }
    destinations.append(menuIcon('apps'));
    footer.append(destinations);
    return {switcher, avatar, menu, account, preferences, quickHelp, destinations, destroy() {}};
  }
  if (options.footerHost || (client && currentWorkspace.kind === 'remote')) {
    const inbox = createNotificationTrigger(client && currentWorkspace.kind === 'remote' ? {client, slug: currentWorkspace.workspaceId,
      onOpenPage: pageId => footer.dispatchEvent(new CustomEvent('blok:desktop-open-page', {detail:{pageId}})),
      onManageRequests: admin ? () => openSettings('members', 'requests') : undefined,
    } : undefined, options.footerHost ? mountSidebarInbox() : undefined);
    if (headerActions) headerActions.prepend(inbox.element);
    else footer.append(inbox.element);
    options.signal?.addEventListener('abort', () => inbox.destroy(), {once:true});
  }

  const sessionInfo = client?.session();
  if (sessionInfo) {
    void sessionInfo.then((session) => {
      // The address a member is told to contact, served by /api/session: the
      // longest-standing instance administrator. Never the viewer's own inbox,
      // and the entry is hidden rather than shown disabled when there is none.
      const support = session.supportEmail ?? '';
      ui.supportEmail = support && support !== session.user.email ? support : null;
    }).catch(() => { /* no support address */ });
  }
  const helpItems = () => {
    const workspaceId = currentWorkspace.kind === 'remote' ? currentWorkspace.workspaceId : currentWorkspace.id;
    return [
      {
        name: 'getting-started',
        title: shellText("Premiers pas"),
        closeOnActivate: true,
        onActivate: () => {
          footer.dispatchEvent(new CustomEvent('blok:desktop-open-page', {
            bubbles: true,
            detail: { pageId: welcomePageId(workspaceId), seedWelcome: true },
          }));
        },
      },
      {
        name: 'who-sees',
        title: shellText("Qui peut voir quoi"),
        closeOnActivate: true,
        onActivate: () => {
          footer.dispatchEvent(new CustomEvent('blok:desktop-open-page', {
            bubbles: true,
            detail: { pageId: welcomeRightsPageId(workspaceId), seedWelcome: true },
          }));
        },
      },
      {
        name: 'shortcuts',
        title: shellText("Raccourcis"),
        closeOnActivate: true,
        onActivate: () => {
          showShortcutsDialog();
        },
      },
      // Omitted when the instance has no address to offer: a permanently
      // greyed row teaches nothing and reads as broken.
      ...(ui.supportEmail ? [{
        name: 'report',
        title: shellText("Signaler un problème"),
        closeOnActivate: true,
        onActivate: () => {
          const address = ui.supportEmail;
          if (!address) return;
          location.href = `mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent('Signaler un problème — Blok')}`;
        },
      }] : []),
      {
        name: 'version',
        title: shellText("Blok {v0} · App {v1}", {v0: CORE_VERSION, v1: APP_VERSION}),
        isDisabled: true,
        onActivate: () => undefined,
      },
    ];
  };
  const destinationsItems = () => [
      {name: 'library', icon: IconLibrary, title: shellText("Bibliothèque"), closeOnActivate: true, onActivate: () => footer.dispatchEvent(new Event('blok:desktop-open-library', {bubbles:true}))},
      {name: 'calendar', icon: IconCalendar, title: shellText("Calendrier"), closeOnActivate: true, onActivate: () => footer.dispatchEvent(new Event('blok:desktop-open-agenda', {bubbles:true}))},
      ...(currentWorkspace.kind === 'remote' ? [{name: 'trash', icon: IconTrash, title: shellText("Corbeille"), closeOnActivate: true, onActivate: () => footer.dispatchEvent(new Event('blok:desktop-open-trash', {bubbles:true}))}] : []),
    ];
  const openFooterPopup = (trigger: HTMLButtonElement): void => {
    const alreadyOpen = trigger.getAttribute('aria-expanded') === 'true';
    ui.footerPopup?.hide();
    closeMenu();
    if (alreadyOpen) return;
    const isHelp = trigger === legacy?.quickHelp;
    const items = isHelp ? helpItems() : destinationsItems();
    const popup = new PopoverDesktop({
      trigger,
      width: 'auto',
      minWidth: isHelp ? '220px' : '240px',
      items,
      class: 'desktop-footer-popover',
    });
    popup.getElement().setAttribute(isHelp ? 'data-desktop-help-popover' : 'data-desktop-destinations-popover', '');
    const palette = getComputedStyle(trigger);
    for (const token of ['--blok-popover-bg', '--blok-popover-border', '--blok-text-primary', '--blok-text-secondary', '--blok-item-hover-bg']) {
      const value = palette.getPropertyValue(token);
      if (value) popup.getElement().style.setProperty(token, value);
    }
    ui.footerPopup = popup;
    trigger.setAttribute('aria-expanded', 'true');
    const closed = { settled: false };
    popup.on('closed', () => {
      if (closed.settled) return;
      closed.settled = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (ui.footerPopup === popup) ui.footerPopup = null;
      queueMicrotask(() => popup.destroy());
    });
    popup.show();
  };
  for (const trigger of legacy ? [legacy.quickHelp, legacy.destinations] : []) {
    trigger.addEventListener('click', () => openFooterPopup(trigger));
  }
  const emitCloud = (section: WebAccountAction | 'settings' | 'invites' | 'local-server' | 'embedded-server'): void => {
    closeMenu();
    footer.dispatchEvent(new CustomEvent('blok:desktop-connect-cloud', {bubbles: true, detail: {section}}));
  };
  const all = listWorkspaces();
  const remote = all.filter((ref) => ref.kind === 'remote');
  const webAccount = hasWebAccount(currentWorkspace, native) ? currentWorkspace : null;
  if (webAccount && !remote.some(ref => workspaceKey(ref) === workspaceKey(webAccount))) remote.push(webAccount);
  const creation: {revision: number; refresh?: () => void} = {revision: 0};
  const groups = new Map<string, typeof remote>();
  for (const ref of remote) {
    if (ref.embedded) continue;
    const email = ref.userName?.trim() || 'Compte sur ' + (ref.server || location.origin);
    const members = groups.get(email) ?? [];
    members.push(ref); groups.set(email, members);
  }
  if (options.footerHost) {
    const choices: FooterChoices = {
      current:currentWorkspace, groups, webAccount, offlineProfile,
      locals:native ? all.filter(ref => ref.kind === 'local' || ref.embedded) : undefined,
      invite:admin && !onDevice ? () => { closeMenu(); openInvitation(); } : undefined,
      connect:() => emitCloud('account'), createRemote:() => emitCloud('new-workspace'), logout:() => emitCloud('logout'),
      select:ref => {
        closeMenu();
        if (workspaceKey(ref) !== workspaceKey(currentWorkspace)) footer.dispatchEvent(new CustomEvent('blok:desktop-select-workspace', {bubbles:true, detail:ref}));
      },
      createLocal:() => {
        closeMenu();
        openLocalWorkspaceDialog(name => footer.dispatchEvent(new CustomEvent('blok:desktop-select-workspace', {bubbles:true, detail:createLocalWorkspace(name)})));
      },
    };
    reactSurface = mountFooterSurface(options.footerHost, {
      name: currentWorkspace.name, context, choices, helpItems, destinations: destinationsItems,
      onSettings: panel => openSettings(panel),
      async canCreate() {
        if (!webAccount || !client) return false;
        const [instance,session] = await Promise.all([client.instance(),client.session()]);
        return !options.signal?.aborted && session.user.id === webAccount.accountId && canCreateWorkspace(instance,session);
      },
    });
  } else if (legacy) {
    mountLegacyChoices(legacy);
  }

  function mountLegacyChoices({menu, account, preferences}: ReturnType<typeof legacyFooterSurface>) {
    const connect = actionButton('data-desktop-menu-connect', offlineProfile ? shellText("Se connecter à un serveur distant") : shellText("Ajouter un compte"), 'profile');
    connect.setAttribute('data-desktop-menu-item', '');
    connect.setAttribute('role', 'menuitem');
    connect.removeAttribute('title');
    connect.addEventListener('click', () => emitCloud('account'));
    menu.append(account, preferences);
    if (admin && !onDevice) {
      const people = actionButton('data-desktop-menu-invite', shellText("Inviter des membres"), 'people');
      people.setAttribute('data-desktop-menu-item', ''); people.setAttribute('role', 'menuitem');
      people.removeAttribute('title');
      people.addEventListener('click', () => { closeMenu(); openInvitation(); });
      menu.append(people);
    }
    menu.append(connect);
    const addChoice = (ref: (typeof all)[number], group: HTMLElement): void => {
      const choice = actionButton('data-desktop-menu-workspace', ref.name, 'storage');
      const label = el('span', 'data-desktop-menu-workspace-name', ref.name);
      choice.replaceChildren(el('span', 'data-desktop-workspace-avatar', ref.name.charAt(0).toLocaleUpperCase()), label);
      choice.removeAttribute('title');
      choice.setAttribute('role', 'menuitemradio');
      choice.setAttribute('data-desktop-menu-item', '');
      const current = workspaceKey(ref) === workspaceKey(currentWorkspace);
      choice.setAttribute('aria-checked', String(current));
      if (current) {
        choice.setAttribute('aria-current', 'true');
        const check = el('span', 'data-desktop-menu-check', '✓');
        check.setAttribute('aria-hidden', 'true'); choice.append(check);
      }
      choice.addEventListener('click', () => {
        closeMenu();
        if (!current) footer.dispatchEvent(new CustomEvent('blok:desktop-select-workspace', { bubbles: true, detail: ref }));
      });
      group.append(choice);
    };
    for (const [email, refs] of groups) {
      const group = el('div', 'data-desktop-menu-group');
      group.setAttribute('role', 'group'); group.setAttribute('aria-label', email);
      group.append(el('div', 'data-desktop-menu-group-label', email));
      for (const ref of refs) addChoice(ref, group);
      if (webAccount && client && refs.some(ref => workspaceKey(ref) === workspaceKey(webAccount))) {
        const add = actionButton('data-desktop-menu-new-workspace', shellText("Nouvel espace"), 'add');
        add.removeAttribute('title');
        add.setAttribute('data-desktop-menu-item', '');
        add.setAttribute('role', 'menuitem');
        add.addEventListener('click', () => emitCloud('new-workspace'));
        creation.refresh = () => {
          const current = ++creation.revision;
          add.remove();
          void Promise.all([client.instance(), client.session()]).then(([instance, session]) => {
            if (current === creation.revision && !menu.hidden && !options.signal?.aborted && session.user.id === webAccount.accountId &&
              canCreateWorkspace(instance, session)) group.append(add);
          }).catch(() => { /* Creation is available after the server confirms permission. */ });
        };
      }
      menu.append(group);
    }
    if (native) {
      const group = el('div', 'data-desktop-menu-group');
      group.setAttribute('role', 'group'); group.setAttribute('aria-label', shellText("Sur cet appareil"));
      group.append(el('div', 'data-desktop-menu-group-label', shellText("Sur cet appareil")));
      for (const ref of all.filter((item) => item.kind === 'local' || item.embedded)) addChoice(ref, group);
      const addLocal = actionButton('data-desktop-menu-new-workspace', shellText("Créer un espace local"), 'add');
      addLocal.removeAttribute('title');
      addLocal.setAttribute('data-desktop-menu-item', ''); addLocal.setAttribute('role', 'menuitem');
      addLocal.addEventListener('click', () => {
        closeMenu();
        openLocalWorkspaceDialog((name) => {
          footer.dispatchEvent(new CustomEvent('blok:desktop-select-workspace', {bubbles: true, detail: createLocalWorkspace(name)}));
        });
      });
      group.append(addLocal); menu.append(group);
    }
    if (webAccount) {
      const actions = el('div', 'data-desktop-menu-group');
      const logout = el('button', 'data-desktop-menu-logout', shellText("Se déconnecter"));
      logout.type = 'button';
      logout.setAttribute('role', 'menuitem');
      logout.setAttribute('data-desktop-menu-item', '');
      logout.addEventListener('click', () => emitCloud('logout'));
      actions.append(logout);
      menu.append(actions);
    }
    footer.append(menu);
  }

  const overlay = el('div', 'data-desktop-settings-overlay');
  overlay.hidden = true;
  const dialog = el('div', 'data-desktop-settings-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', shellText("Réglages"));
  dialog.tabIndex = -1;
  const nav = el('nav', 'data-desktop-settings-nav');
  nav.setAttribute('aria-label', shellText("Rubriques des réglages"));
  const search = el('input', 'data-desktop-settings-search');
  search.type = 'search'; search.placeholder = shellText("Rechercher un réglage");
  search.setAttribute('aria-label', shellText("Rechercher dans les réglages"));
  const searchBox = wrapSearchField(search);
  const navList = el('div', 'data-desktop-settings-nav-list');
  const resultList = el('div', 'data-settings-results');
  resultList.hidden = true;
  const noResults = el('p', 'data-desktop-settings-no-results', shellText("Aucun réglage trouvé."));
  noResults.hidden = true; noResults.setAttribute('role', 'status');
  nav.append(searchBox, navList, resultList, noResults);
  const sidebar = options.sidebarPreferences ?? createSidebarPreferences(workspaceKey(currentWorkspace), true);
  const catalog = settingsCatalog(currentWorkspace, sidebar, native, Boolean(options.importMarkdown));
  const navEntries: SettingsTab[] = [];
  let groupName = '';
  let resultsView: ReturnType<typeof mountSettingsSearchResults> | undefined;
  let pendingFocus: AbortController | undefined;
  const panelTabs = new Map<SettingsPanel, HTMLButtonElement>();
  function group(label:string) { groupName = label; navList.append(el('div', 'data-desktop-settings-nav-heading', label)); }
  function tab(panel:SettingsPanel, label:string, kind:MenuIcon, keywords:string, icon?:string) {
    const button = actionButton('data-desktop-settings-nav-item', label, kind);
    const iconElement = button.firstElementChild;
    if (icon && iconElement) iconElement.outerHTML = icon.trim().replace(/>\s+</g,'><');
    button.dataset.settingsTab = panel;
    button.addEventListener('click', () => showPanel(panel));
    panelTabs.set(panel,button); navEntries.push({panel, group:groupName, button, keywords}); navList.append(button);
    return button;
  }
  group(shellText("Compte"));
  const localProfileName = currentWorkspace.kind === 'local' && currentWorkspace.id === 'default'
    ? localStorage.getItem('blok:desktop:profile-name') : null;
  const profile = currentWorkspace.kind === 'remote'
    ? currentWorkspace.userName?.trim() || (onDevice ? shellText("Profil local") : shellText("Mon compte"))
    : localProfileName || currentWorkspace.name;
  const accountTab = tab('account',profile,'profile','compte profil identité email');
  const initial = el('span','data-settings-profile-avatar');
  initial.dataset.initial = Array.from(profile)[0]?.toLocaleUpperCase();
  initial.setAttribute('aria-hidden','true'); accountTab.firstElementChild?.replaceWith(initial);
  function updateAccountName(name: string) {
    accountTab.title = name;
    const accountLabel = accountTab.querySelector('[data-desktop-action-label]');
    if (accountLabel) accountLabel.textContent = name;
    initial.dataset.initial = Array.from(name)[0]?.toLocaleUpperCase();
    filterNav();
  }
  tab('preferences',shellText("Préférences"),'settings','apparence thème clair sombre contraste entrée conversation',IconSliders);
  if (client) tab('notifications',shellText("Notifications"),'help','boîte de réception inbox compteur épinglage alertes mentions commentaires',IconBell);
  tab('calendar',shellText("Calendrier"),'connections','agenda google abonnements disponibilités mail ical',IconCalendar);
  group(shellText("Espace de travail"));
  tab('general',shellText("Général"),'settings','espace nom stockage');
  if (admin && onDevice && currentWorkspace.device && options.flushForBackup)
    tab('backups',shellText("Sauvegardes"),'storage','git github gitlab lfs dépôt dossier nas s3 backup restauration');
  if (admin && !onDevice) tab('members',shellText("Membres"),'people','personnes invitations accès rôles');
  tab('sidebar',shellText("Barre latérale"),'storage','navigation personnaliser favoris sections',IconSidebarRight);
  tab('import',shellText("Importer"),'storage',options.importMarkdown ? 'fichiers markdown agenda calendrier ics' : 'fichiers agenda calendrier ics',IconDownload);
  group(shellText("Fonctionnalités"));
  tab('ai',shellText("Assistant IA"),'ai','assistant openai modèle clé api');
  tab('connections',shellText("Connexions"),'apps',client ? 'comptes serveur distant espace' : 'comptes serveur distant espace mcp');
  if (client) tab('mcp',shellText("Blok MCP"),'connections','accès jetons codex clients serveur');
  tab('emojis',shellText("Émojis"),'emoji','emoji image icône logo');
  if (reactGrabAvailable) tab('developer',shellText("Développeur"),'connections','react grab inspecter composant sélection source');
  if (currentWorkspace.kind === 'remote' && options.teamPages) {
    group(shellText("Organisation"));
    tab('teams',shellText("Espaces d’équipe"),'people','teamspaces groupes membres équipes propriétaires accès',IconBuilding);
  }
  const filterNav = (): void => {
    const query = search.value.trim();
    navList.hidden = Boolean(query);
    resultList.hidden = !query;
    if (!query) {
      resultsView?.destroy();
      resultsView = undefined;
      noResults.hidden = true;
      return;
    }
    const groups = findSettings(query, navEntries, catalog);
    resultsView ??= mountSettingsSearchResults(resultList, (panel, setting) => {
      search.value = '';
      filterNav();
      showPanel(panel);
      pendingFocus = new AbortController();
      revealSetting(main, setting.selector, pendingFocus.signal);
    });
    resultsView.render(groups);
    noResults.hidden = groups.length > 0;
  };
  if (sessionInfo && !onDevice) {
    void sessionInfo.then((session) => {
      const name = session.user.name?.trim() || session.user.email;
      if (name) updateAccountName(name);
      if (!session.user.instanceAdmin) return;
      group(shellText("Instance"));
      for (const item of [
        tab('instance-general', shellText("Général"), 'storage', 'instance général nom adresse versions'),
        tab('instance-access', shellText("Accès"), 'settings', 'instance accès inscription signup politique espaces'),
        tab('instance-accounts', shellText("Comptes"), 'profile', 'instance comptes utilisateurs administrateurs'),
        tab('instance-workspaces', shellText("Espaces"), 'storage', 'instance espaces workspaces métadonnées'),
        tab('instance-health', shellText("Santé et e-mail"), 'connections', 'instance santé email smtp test livraison'),
      ]) item.setAttribute('data-instance-panel', '');
      filterNav();
    }).catch(() => { /* Session unavailable: no Instance rubrique. */ });
  }
  const visibleButtons = () => (navList.hidden ? resultList : navList).querySelectorAll<HTMLButtonElement>('button:not([hidden])');
  search.addEventListener('input', filterNav);
  search.addEventListener('keydown', (event) => {
    if (event.isComposing || !['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const results = visibleButtons();
    if (event.key === 'Enter') results[0]?.click();
    else results[event.key === 'ArrowDown' ? 0 : results.length - 1]?.focus();
  });
  nav.addEventListener('keydown', (event) => {
    if (event.target === search || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const rows = [...visibleButtons()];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    switch (event.key) {
      case 'ArrowUp': (rows[index - 1] ?? search).focus(); break;
      case 'ArrowDown': rows[Math.min(index + 1, rows.length - 1)].focus(); break;
      case 'Home': rows[0].focus(); break;
      case 'End': rows[rows.length - 1].focus(); break;
      default: return;
    }
    event.preventDefault();
  });
  const main = el('main', 'data-desktop-settings-main');
  const sections = el('button', 'data-desktop-settings-sections', shellText("Rubriques"));
  sections.type = 'button';
  nav.id = 'settings-nav-' + crypto.randomUUID();
  sections.setAttribute('aria-controls', nav.id);
  const showSections = (expanded: boolean) => {
    dialog.toggleAttribute('data-show-sections', expanded);
    sections.setAttribute('aria-expanded', String(expanded));
    if (expanded) search.focus();
  };
  // A delayed server response must leave focus alone once the user moves on.
  for (const event of ['pointerdown', 'keydown']) {
    dialog.addEventListener(event, () => pendingFocus?.abort(), true);
  }
  dialog.addEventListener('focusin', event => { if (event.target !== main) pendingFocus?.abort(); }, true);
  sections.addEventListener('click', () => {
    const open = !dialog.hasAttribute('data-show-sections');
    showSections(open);
    if (!open) sections.focus();
  });
  const close = el('button', 'data-desktop-settings-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', shellText("Fermer les réglages"));
  dialog.append(sections, close, nav, main);
  overlay.append(dialog);
  document.body.append(overlay);

  function bindLegacyMenu({menu, switcher, preferences}: ReturnType<typeof legacyFooterSurface>) {
    const close = (): void => {
      menu.hidden = true;
      switcher.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outsideMenu, true);
      document.removeEventListener('keydown', menuKey);
    };
    const outsideMenu = (event: PointerEvent): void => {
      if (event.target instanceof Node && footer.contains(event.target)) return;
      close();
    };
    const menuKey = (event: KeyboardEvent): void => {
      if (ui.footerPopup?.isShown) return;
      if (event.key === 'Escape' || event.key === 'Tab') { close(); switcher.focus(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = [...menu.querySelectorAll<HTMLButtonElement>('[role=menuitem], [role=menuitemradio]')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const first = delta > 0 ? 0 : items.length - 1;
        const index = current < 0 ? first : (current + delta + items.length) % items.length;
        items[index]?.focus();
      }
    };
    const openWorkspaceMenu = (keyboard: boolean): void => {
      ui.footerPopup?.hide();
      menu.hidden = false;
      creation.refresh?.();
      switcher.setAttribute('aria-expanded', 'true');
      if (keyboard) preferences.focus();
      document.addEventListener('pointerdown', outsideMenu, true);
      document.addEventListener('keydown', menuKey);
    };
    switcher.addEventListener('click', event => {
      if (!menu.hidden) { close(); return; }
      openWorkspaceMenu(event.detail === 0);
    });
    switcher.addEventListener('keydown', event => {
      if (!menu.hidden || event.key !== 'ArrowDown') return;
      event.preventDefault();
      event.stopPropagation();
      openWorkspaceMenu(true);
    });

    return close;
  }
  const closeMenu = legacy ? bindLegacyMenu(legacy) : () => reactSurface?.close();

  const closeSettings = (): void => { ui.modal?.close(); };
  close.addEventListener('click', closeSettings);

  const showPanel = (panel: SettingsPanel, initialTab?: 'requests' | 'create'): void => {
    pendingFocus?.abort();
    const selectedFromSections = dialog.hasAttribute('data-show-sections') && nav.contains(document.activeElement);
    showSections(false);
    if (selectedFromSections && sections.getClientRects().length) sections.focus();
    main.scrollTop = 0;
    for (const [name, tab] of panelTabs) {
      tab.setAttribute('aria-current', panel === name ? 'page' : 'false');
    }
    ui.members?.destroy(); ui.members = null;
    ui.instancePanel?.destroy(); ui.instancePanel = null;
    ui.choices.splice(0).forEach((choice) => choice.destroy());
    ++ui.panelGeneration;
    main.querySelector('[data-desktop-settings-content]')?.remove();
    const content = el('div', 'data-desktop-settings-content');
    const panelSource = settingsPanelSource(panel);
    content.dataset.settingsSource = `desktop/src/${panelSource}`;
    nav.dataset.settingsSource = 'desktop/src/settings.ts';
    if (panel.startsWith('instance-') && client) {
      const kind = panel.slice('instance-'.length) as InstancePanel;
      content.dataset.settingsSource = 'desktop/src/instance/instance-settings.ts';
      main.append(content);
      ui.instancePanel = mountInstanceSettings(content, kind, {
        client,
        dialog,
        publicUrl: currentWorkspace.kind === 'remote' ? currentWorkspace.server : '',
        coreVersion: CORE_VERSION,
        appVersion: APP_VERSION,
      });
      return;
    }
    if (panel === 'developer' && reactGrabAvailable) {
      content.append(el('h1', 'data-desktop-settings-title', shellText("Développeur")), el('p', 'data-desktop-settings-intro', shellText("Inspectez les composants de l’interface de Blok.")));
      const feedback = el('div', 'data-desktop-settings-feedback');
      feedback.setAttribute('data-react-grab-ignore', '');
      const grab = actionButton('data-desktop-settings-grab', shellText("Sélectionner un élément"), 'connections');
      const hint = el('small', 'data-desktop-settings-grab-hint', shellText("React Grab · ⌘/Ctrl + ⇧ + G"));
      grab.addEventListener('click', () => {
        grab.disabled = true;
        void loadReactGrab().then((api) => { api.activate(); hint.textContent = shellText("Sélectionnez un élément, puis collez-le dans le chat."); })
          .catch(() => { hint.textContent = shellText("Chargement impossible. Réessayez."); }).finally(() => { grab.disabled = false; });
      });
      feedback.append(grab, hint); content.append(feedback);
    } else if (panel === 'notifications' || panel === 'sidebar') {
      ui.choices.push(mountShellNavigationSettings(content,panel === 'notifications'
        ? {kind:panel, scope: client && currentWorkspace.kind === 'remote' ? {client, slug: currentWorkspace.workspaceId} : undefined}
        : {kind:panel, sidebar}));
    } else if (panel === 'calendar' || panel === 'import') {
      content.classList.add('settings-panel');
      const importMarkdown = options.importMarkdown;
      ui.choices.push(mountCalendarImportSettings(content, currentWorkspace, client, panel === 'calendar'
        ? {kind:panel, openAgenda() { closeSettings(); footer.dispatchEvent(new Event('blok:desktop-open-agenda',{bubbles:true})); }}
        : {kind:panel, importMarkdown:importMarkdown && (async file=>{
          await importMarkdown(file);
          if (content.isConnected && !overlay.hidden) closeSettings();
        })}));
    } else if (panel === 'teams' && options.teamPages && currentWorkspace.kind === 'remote' && client) {
      const navigation = options.teamPages;
      const destroy = openTeamspaces(currentWorkspace, {...navigation, initialView: initialTab === 'create' ? 'create' : undefined, open:async (id,signal)=>{
        await navigation.open(id,signal);
        if (!signal.aborted) closeSettings();
      }}, client, content);
      ui.choices.push({destroy});
    } else if (panel === 'backups' && currentWorkspace.kind === 'remote' && options.flushForBackup) {
      content.classList.add('settings-panel');
      content.append(el('h1', 'data-desktop-settings-title', shellText("Sauvegardes")));
      ui.choices.push(mountWorkspaceBackup(content, currentWorkspace, options.flushForBackup));
    } else if (panel === 'mcp' && client) {
      mountMcpSettings(content, client);
    } else if (panel === 'connections') {
      content.append(el('h1', 'data-desktop-settings-title', shellText("Connexions")), el('p', 'data-desktop-settings-intro', shellText("Gérez vos comptes et connectez vos outils à Blok.")));
      const accounts = el('section', 'data-desktop-connections-accounts');
      const labels = el('div', 'data-desktop-settings-row-labels');
      labels.append(el('strong', 'data-desktop-settings-row-title', offlineProfile ? shellText("Serveur distant") : shellText("Comptes et espaces")), el('span', 'data-desktop-settings-row-help', offlineProfile ? shellText("Accédez aux espaces d’un autre serveur Blok.") : shellText("Ouvrez un autre espace ou connectez-vous avec une autre adresse.")));
      const accountAction = client ? shellText("Gérer les comptes") : shellText("Se connecter");
      const manage = actionButton('data-desktop-settings-copy', offlineProfile ? shellText("Se connecter à un serveur distant") : accountAction, 'profile');
      manage.addEventListener('click', () => { closeSettings(); emitCloud('account'); });
      accounts.append(labels, manage); content.append(accounts);
      if (native && (currentWorkspace.kind === 'local' || !currentWorkspace.embedded)) {
        const server = el('section', 'data-desktop-connections-accounts');
        const info = el('div', 'data-desktop-settings-row-labels');
        void embeddedServerAvailable().then(available => {
          if (!content.isConnected || (!available && currentWorkspace.kind === 'remote' && currentWorkspace.server === LOCAL_SERVER_ORIGIN)) return;
          info.append(el('strong', 'data-desktop-settings-row-title', shellText("Serveur sur cet ordinateur")),
            el('span', 'data-desktop-settings-row-help', available ? shellText("Serveur intégré à Blok") : LOCAL_SERVER_ORIGIN + ' · Docker'));
          const open = actionButton('data-desktop-settings-copy', available ? shellText("Ouvrir le serveur intégré") : shellText("Ouvrir le serveur local"), 'connections');
          open.addEventListener('click', () => { closeSettings(); emitCloud(available ? 'embedded-server' : 'local-server'); });
          server.append(info, open); content.append(server);
        });
      }
      main.append(content);
      return;
    }
    if (panel === 'emojis') {
      content.append(el('h1', 'data-desktop-settings-title', shellText("Émojis")));
      ui.choices.push(mountCustomEmojiSettings(content, currentWorkspace));
      main.append(content);
      return;
    }
    if (panel === 'members' && admin && client && currentWorkspace.kind === 'remote') {
      content.append(el('h1', 'data-desktop-settings-title', shellText("Membres")));
      main.append(content);
      ui.members = mountWorkspaceMembers(content, {client, slug: currentWorkspace.workspaceId, initialTab: initialTab === 'requests' ? 'requests' : undefined, onInvite: () => openInvitation(dialog)});
      return;
    }
    if (panel === 'account' && currentWorkspace.kind === 'remote') {
      if (onDevice) {
        ui.choices.push(mountSettingsPanel(content, {
          kind: 'device', name: currentWorkspace.userName || 'Profil local', workspace: currentWorkspace.name,
        }));
      } else {
        content.setAttribute('data-desktop-account', '');
        ui.choices.push(mountSettingsPanel(content, {
          kind: 'remote', email: client?.currentSession?.user.email || currentWorkspace.userName, name:client?.currentSession?.user.name, workspace: currentWorkspace.name,
          role: WORKSPACE_ROLES[currentWorkspace.role ?? 'member'],
          openAccounts() { closeSettings(); emitCloud('account'); },
        }));
      }
    } else if (panel === 'account' && currentWorkspace.kind === 'local') {
      ui.choices.push(mountSettingsPanel(content, {
        kind: 'local', name: displayName,
        rename(next) {
          if (currentWorkspace.id === 'default') localStorage.setItem('blok:desktop:profile-name', next);
          else rememberWorkspace({...currentWorkspace, name: next});
          updateAccountName(next);
          setProfileName(next);
        },
      }));
    } else if (panel === 'preferences') {
      ui.choices.push(mountSettingsPanel(content, {
        kind: 'preferences', appearance: readAppearance(), onLanguageChange: options.onLanguageChange,
        readDirectory: native && currentWorkspace.kind === 'local' ? () => dataDirectory(currentWorkspace) : undefined,
        onAppearanceChange(mode) {
          localStorage.setItem(KEY, mode);
          const root = document.querySelector('[data-desktop-shell]');
          if (root instanceof HTMLElement) applyAppearance(root, mode);
          onThemeChange(mode);
        },
      }));
    } else if (panel === 'ai') {
      ui.choices.push(mountAiSettings(content, currentWorkspace));
    } else if (panel === 'general') {
      ui.choices.push(mountSettingsPanel(content, {
        kind: 'general', workspace: currentWorkspace.name,
        remoteServer: currentWorkspace.kind === 'remote' && !onDevice ? currentWorkspace.server || location.origin : undefined,
        version: `Blok ${CORE_VERSION} · App ${APP_VERSION}`,
      }));
    }

    main.append(content);
  };
  const openSettings = (panel: SettingsPanel, initialTab?: 'requests' | 'create', fromShortcut = false): void => {
    if (ui.modal) return;
    closeMenu();
    search.value = ''; filterNav();
    showPanel(panel, initialTab);
    if (!fromShortcut) focusSwitcher();
    overlay.hidden = false;
    ui.modal = openModalDialog({
      content: overlay, surface: dialog, label: shellText("Paramètres"), initialFocus: () => fromShortcut && search.getClientRects().length ? search : dialog,
      onDismiss: (reason) => {
        if (reason === 'escape' && nav.contains(document.activeElement) && search.value) {
          search.value = ''; filterNav(); search.focus(); return;
        }
        if (reason === 'escape' && dialog.hasAttribute('data-show-sections')) {
          showSections(false); sections.focus(); return;
        }
        closeSettings();
      },
      onClose: () => {
        pendingFocus?.abort();
        search.value = ''; filterNav();
        overlay.hidden = true; ++ui.panelGeneration;
        ui.choices.splice(0).forEach((choice) => choice.destroy());
        ui.members?.destroy(); ui.members = null;
        ui.instancePanel?.destroy(); ui.instancePanel = null;
        ui.modal = null;
      },
    });
  };
  footer.addEventListener('blok:desktop-open-preferences', () => openSettings('preferences', undefined, true));
  footer.addEventListener('blok:desktop-open-ai-settings', () => openSettings('ai'));
  footer.addEventListener('blok:desktop-open-settings', (event) => {
    const section = (event as CustomEvent<string>).detail;
    if (section === 'invites' && admin) { closeMenu(); openInvitation(); }
    else if (section === 'preferences') openSettings('preferences');
    else if (section === 'calendar' || section === 'import') openSettings(section);
    else if (section === 'backups' && panelTabs.has('backups')) openSettings('backups');
    else if (section === 'members' && admin) openSettings('members');
    else if ((section === 'teams' || section === 'teams-create') && panelTabs.has('teams')) openSettings('teams', section === 'teams-create' ? 'create' : undefined);
    else openSettings('general');
  });
  let displayName = localProfileName || currentWorkspace.name;
  function setProfileName(name: string) {
    displayName = name;
    if (reactSurface) reactSurface.rename(name);
    if (!legacy) return;
    const {switcher, avatar, account} = legacy;
    const label = switcher.querySelector('[data-desktop-switcher-name]');
    if (label) label.textContent = name;
    avatar.textContent = Array.from(name)[0]?.toLocaleUpperCase() || 'B';
    const menuAvatar = account.querySelector('[data-desktop-menu-avatar]');
    if (menuAvatar) menuAvatar.textContent = avatar.textContent;
    const title = account.querySelector('[data-desktop-menu-title]');
    if (title) title.textContent = name;
  }
  setProfileName(displayName);
  legacy?.preferences.addEventListener('click', () => openSettings('preferences'));
  legacy?.account.addEventListener('click', () => openSettings('account'));
  if (currentWorkspace.kind === 'remote') legacy?.switcher.setAttribute('aria-label',shellText("Espaces et réglages"));
  const pendingSettings = sessionStorage.getItem('blok:desktop:pending-settings');
  if (pendingSettings) {
    sessionStorage.removeItem('blok:desktop:pending-settings');
    queueMicrotask(() => {
      footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', {detail: pendingSettings}));
    });
  }
  options.signal?.addEventListener('abort', () => {
    closeMenu();
    ui.footerPopup?.hide();
    ui.modal?.close();
    overlay.remove();
    reactSurface?.destroy();
  }, {once:true});
  return footer;
}
