<<<<<<< HEAD
<<<<<<< HEAD
import { createSidebarPreferences, type SidebarPreferences } from '../../src/shell/sidebar-preferences';
import { IconBell, IconBuilding, IconCalendar, IconLibrary, IconDownload, IconSidebarRight, IconSliders, IconTrash } from '../../src/components/icons';
import {mountShellNavigationSettings} from './shell-navigation-settings';
import {mountCalendarImportSettings} from './settings-calendar-import';
import {openTeamspaces, type TeamPageNavigation} from './cloud/teamspaces';
import { showShortcutsDialog } from './shortcuts-dialog';
import { WORKSPACE_ROLES } from './access-vocabulary';
import { styleTextField, wrapSearchField } from './ui/controls';
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
  surface.append(el('h2', 'data-desktop-settings-title', 'Nouvel espace local'));
  const form = document.createElement('form');
  const name = el('input', 'data-desktop-settings-name');
  name.type = 'text';
  styleTextField(name);
  name.placeholder = 'Nom de l’espace';
  name.setAttribute('aria-label', 'Nom de l’espace');
  name.required = true;
  name.maxLength = 80;
  const actions = el('div', 'data-desktop-account-actions');
  const cancel = el('button', 'data-desktop-settings-copy', 'Annuler');
  cancel.type = 'button';
  const submit = el('button', 'data-desktop-settings-copy', 'Créer');
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(name, actions);
  surface.append(form);
  overlay.append(surface);
  const handle = openModalDialog({
    content: overlay,
    surface,
    label: 'Nouvel espace local',
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
  const paths: Record<MenuIcon, string> = {
    profile: 'M10 10.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2ZM3.7 16.5c.3-2.8 2.7-4.6 6.3-4.6s6 1.8 6.3 4.6H3.7Z',
    settings: 'M8.4 2.8h3.2l.5 2 1.5.8 2-.5 1.5 2.7-1.5 1.4v1.7l1.5 1.4-1.5 2.7-2-.5-1.5.8-.5 2H8.4l-.5-2-1.5-.8-2 .5-1.5-2.7 1.5-1.4V9.2L2.9 7.8l1.5-2.7 2 .5 1.5-.8.5-2ZM12.8 10a2.8 2.8 0 1 1-5.6 0 2.8 2.8 0 0 1 5.6 0Z',
    apps: 'M8 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM17 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM8 14a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM17 14a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
    people: 'M12.6 8.3a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6ZM6.2 9.7a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6ZM7.5 16c0-3.5 2-5.1 5.1-5.1s5.1 1.6 5.1 5.1H7.5ZM2.1 15.6c0-2.5 1.5-4.2 4.4-4.2',
    add: 'M10 4v12M4 10h12',
    ai: 'M10 2.5l1.6 5.1L17 9.2l-5.4 1.6L10 16l-1.6-5.2L3 9.2l5.4-1.6L10 2.5ZM16.5 14.3l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5.5-1.2Z',
    connections: 'M8 12l4-4M7 13l-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M13 7l1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0',
    emoji: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM7 8h.01M13 8h.01M7 12c1.5 2 4.5 2 6 0',
    storage: 'M3 5.2h5l1.3 1.5H17v8.1H3V5.2Z',
    help: 'M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM10 14.2h.01M8.4 7.6a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.9.7-.9 1.3v.4',
  };
  path.setAttribute('d', paths[kind]);
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
    if (!container) switcher.focus();
    return openWorkspaceInvitation({client, slug: currentWorkspace.workspaceId, workspaceName: currentWorkspace.name, container, onComplete: () => ui.members?.refresh()});
  };
  const footer = el('div', 'data-desktop-footer');
  const switcher = el('button', 'data-desktop-switcher');
  switcher.type = 'button';
  switcher.setAttribute('aria-label', 'Espace local et réglages');
  switcher.setAttribute('aria-haspopup', 'menu');
  switcher.setAttribute('aria-expanded', 'false');
  const avatar = el('span', 'data-desktop-avatar', Array.from(currentWorkspace.name)[0]?.toLocaleUpperCase() || 'B');
  avatar.setAttribute('aria-hidden', 'true');
  switcher.append(avatar, el('span', 'data-desktop-switcher-name', 'Espace local'), chevron());
  footer.append(switcher);
  if (client && currentWorkspace.kind === 'remote') {
    const inbox = createNotificationTrigger({client, slug: currentWorkspace.workspaceId,
      onOpenPage: pageId => footer.dispatchEvent(new CustomEvent('blok:desktop-open-page', {detail:{pageId}})),
      onManageRequests: admin ? () => openSettings('members', 'requests') : undefined,
    });
    if (headerActions) headerActions.prepend(inbox.element);
    else footer.append(inbox.element);
    options.signal?.addEventListener('abort', () => inbox.destroy(), {once:true});
  }

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
    el('small', 'data-desktop-menu-context', offlineProfile || currentWorkspace.kind === 'local' ? 'Sur cet appareil' : WORKSPACE_ROLES[currentWorkspace.role ?? 'member']));
  account.append(accountText);
  const preferences = actionButton('data-desktop-menu-item', 'Paramètres', 'settings');
  preferences.setAttribute('role', 'menuitem');
  preferences.setAttribute('data-desktop-menu-preferences', '');
  preferences.removeAttribute('title');
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
  const quickHelp = el('button', 'data-desktop-footer-help');
  quickHelp.type = 'button';
  quickHelp.setAttribute('aria-label', 'Aide et raccourcis');
  quickHelp.title = 'Aide et raccourcis';
  quickHelp.setAttribute('aria-haspopup', 'menu');
  quickHelp.append(menuIcon('help'));
  footer.append(quickHelp);
  const destinations = el('button', 'data-desktop-footer-destinations');
  destinations.type = 'button';
  destinations.setAttribute('aria-label', 'Autres vues de l’espace');
  for (const trigger of [quickHelp, destinations]) {
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
  }
  destinations.append(menuIcon('apps'));
  footer.append(destinations);
  const helpItems = () => {
    const workspaceId = currentWorkspace.kind === 'remote' ? currentWorkspace.workspaceId : currentWorkspace.id;
    return [
      {
        name: 'getting-started',
        title: 'Premiers pas',
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
        title: 'Qui peut voir quoi',
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
        title: 'Raccourcis',
        closeOnActivate: true,
        onActivate: () => {
          showShortcutsDialog();
        },
      },
      // Omitted when the instance has no address to offer: a permanently
      // greyed row teaches nothing and reads as broken.
      ...(ui.supportEmail ? [{
        name: 'report',
        title: 'Signaler un problème',
        closeOnActivate: true,
        onActivate: () => {
          const address = ui.supportEmail;
          if (!address) return;
          location.href = `mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent('Signaler un problème — Blok')}`;
        },
      }] : []),
      {
        name: 'version',
        title: `Blok ${CORE_VERSION} · App ${APP_VERSION}`,
        isDisabled: true,
        onActivate: () => undefined,
      },
    ];
  };
  const openFooterPopup = (trigger: HTMLButtonElement): void => {
    const alreadyOpen = trigger.getAttribute('aria-expanded') === 'true';
    ui.footerPopup?.hide();
    closeMenu();
    if (alreadyOpen) return;
    const isHelp = trigger === quickHelp;
    const items = isHelp ? helpItems() : [
      {name: 'library', icon: IconLibrary, title: 'Bibliothèque', closeOnActivate: true, onActivate: () => footer.dispatchEvent(new Event('blok:desktop-open-library', {bubbles:true}))},
      {name: 'calendar', icon: IconCalendar, title: 'Calendrier', closeOnActivate: true, onActivate: () => footer.dispatchEvent(new Event('blok:desktop-open-agenda', {bubbles:true}))},
      ...(currentWorkspace.kind === 'remote' ? [{name: 'trash', icon: IconTrash, title: 'Corbeille', closeOnActivate: true, onActivate: () => footer.dispatchEvent(new Event('blok:desktop-open-trash', {bubbles:true}))}] : []),
    ];
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
  for (const trigger of [quickHelp, destinations]) {
    trigger.addEventListener('click', () => openFooterPopup(trigger));
  }
  const emitCloud = (section: WebAccountAction | 'settings' | 'invites' | 'local-server' | 'embedded-server'): void => {
    closeMenu();
    footer.dispatchEvent(new CustomEvent('blok:desktop-connect-cloud', {bubbles: true, detail: {section}}));
  };
  const connect = actionButton('data-desktop-menu-connect', offlineProfile ? 'Se connecter à un serveur distant' : 'Ajouter un compte', 'profile');
  connect.setAttribute('data-desktop-menu-item', '');
  connect.setAttribute('role', 'menuitem');
  connect.removeAttribute('title');
  connect.addEventListener('click', () => emitCloud('account'));
  menu.append(account, preferences);
  if (admin && !onDevice) {
    const people = actionButton('data-desktop-menu-invite', 'Inviter des membres', 'people');
    people.setAttribute('data-desktop-menu-item', ''); people.setAttribute('role', 'menuitem');
    people.removeAttribute('title');
    people.addEventListener('click', () => { closeMenu(); openInvitation(); });
    menu.append(people);
  }
  menu.append(connect);
  const all = listWorkspaces();
  const remote = all.filter((ref) => ref.kind === 'remote');
  const webAccount = hasWebAccount(currentWorkspace, native) ? currentWorkspace : null;
  if (webAccount && !remote.some(ref => workspaceKey(ref) === workspaceKey(webAccount))) remote.push(webAccount);
  let refreshCreationAction: (() => void) | undefined;
  const groups = new Map<string, typeof remote>();
  for (const ref of remote) {
    if (ref.embedded) continue;
    const email = ref.userName?.trim() || 'Compte sur ' + (ref.server || location.origin);
    const members = groups.get(email) ?? [];
    members.push(ref); groups.set(email, members);
  }
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
      const add = actionButton('data-desktop-menu-new-workspace', 'Nouvel espace', 'add');
      add.removeAttribute('title');
      add.setAttribute('data-desktop-menu-item', '');
      add.setAttribute('role', 'menuitem');
      add.addEventListener('click', () => emitCloud('new-workspace'));
      let revision = 0;
      refreshCreationAction = () => {
        const current = ++revision;
        add.remove();
        void Promise.all([client.instance(), client.session()]).then(([instance, session]) => {
          if (current === revision && !menu.hidden && !options.signal?.aborted && session.user.id === webAccount.accountId &&
            canCreateWorkspace(instance, session)) group.append(add);
        }).catch(() => { /* Creation is available after the server confirms permission. */ });
      };
    }
    menu.append(group);
  }
  if (native) {
    const group = el('div', 'data-desktop-menu-group');
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Sur cet appareil');
    group.append(el('div', 'data-desktop-menu-group-label', 'Sur cet appareil'));
    for (const ref of all.filter((item) => item.kind === 'local' || item.embedded)) addChoice(ref, group);
    const addLocal = actionButton('data-desktop-menu-new-workspace', 'Créer un espace local', 'add');
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
    const logout = el('button', 'data-desktop-menu-logout', 'Se déconnecter');
    logout.type = 'button';
    logout.setAttribute('role', 'menuitem');
    logout.setAttribute('data-desktop-menu-item', '');
    logout.addEventListener('click', () => emitCloud('logout'));
    actions.append(logout);
    menu.append(actions);
  }
  footer.append(menu);

  const overlay = el('div', 'data-desktop-settings-overlay');
  overlay.hidden = true;
  const dialog = el('div', 'data-desktop-settings-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Réglages');
  dialog.tabIndex = -1;
  const nav = el('nav', 'data-desktop-settings-nav');
  nav.setAttribute('aria-label', 'Rubriques des réglages');
  const search = el('input', 'data-desktop-settings-search');
  search.type = 'search'; search.placeholder = 'Rechercher un réglage';
  search.setAttribute('aria-label', 'Rechercher dans les réglages');
  const searchBox = wrapSearchField(search);
  const navList = el('div', 'data-desktop-settings-nav-list');
  const noResults = el('p', 'data-desktop-settings-no-results', 'Aucune rubrique trouvée.');
  noResults.hidden = true; noResults.setAttribute('role', 'status');
  nav.append(searchBox, navList, noResults);
  type SettingsPanel =
    | 'account' | 'preferences' | 'notifications' | 'calendar' | 'general' | 'members' | 'sidebar' | 'import'
    | 'ai' | 'emojis' | 'connections' | 'mcp' | 'teams' | 'developer'
    | 'instance-general' | 'instance-access' | 'instance-accounts' | 'instance-workspaces' | 'instance-health';
  const navEntries: Array<[HTMLButtonElement, string]> = [];
  const panelTabs = new Map<SettingsPanel, HTMLButtonElement>();
  function group(label:string) { navList.append(el('div', 'data-desktop-settings-nav-heading', label)); }
  function tab(panel:SettingsPanel, label:string, kind:MenuIcon, keywords:string, icon?:string) {
    const button = actionButton('data-desktop-settings-nav-item', label, kind);
    if (icon) button.firstElementChild!.outerHTML = icon.trim().replace(/>\s+</g,'><');
    button.dataset.settingsTab = panel;
    button.addEventListener('click', () => showPanel(panel));
    panelTabs.set(panel,button); navEntries.push([button, keywords]); navList.append(button);
    return button;
  }
  group('Compte');
  const localProfileName = currentWorkspace.kind === 'local' && currentWorkspace.id === 'default'
    ? localStorage.getItem('blok:desktop:profile-name') : null;
  const profile = currentWorkspace.kind === 'remote'
    ? currentWorkspace.userName?.trim() || (onDevice ? 'Profil local' : 'Mon compte')
    : localProfileName || currentWorkspace.name;
  const accountTab = tab('account',profile,'profile','compte profil identité email');
  const initial = el('span','data-settings-profile-avatar');
  initial.dataset.initial = Array.from(profile)[0]?.toLocaleUpperCase();
  initial.setAttribute('aria-hidden','true'); accountTab.firstElementChild?.replaceWith(initial);
  function updateAccountName(name: string) {
    accountTab.title = name;
    accountTab.querySelector('[data-desktop-action-label]')!.textContent = name;
    initial.dataset.initial = Array.from(name)[0]?.toLocaleUpperCase();
    filterNav();
  }
  tab('preferences','Préférences','settings','apparence thème clair sombre contraste entrée conversation',IconSliders);
  if (client) tab('notifications','Notifications','help','boîte de réception inbox compteur épinglage alertes mentions commentaires',IconBell);
  tab('calendar','Calendrier','connections','agenda google abonnements disponibilités mail ical',IconCalendar);
  group('Espace de travail');
  tab('general','Général','settings','espace nom stockage');
  if (admin && !onDevice) tab('members','Membres','people','personnes invitations accès rôles');
  tab('sidebar','Barre latérale','storage','navigation personnaliser favoris sections',IconSidebarRight);
  tab('import','Importer','storage','fichiers markdown agenda calendrier ics',IconDownload);
  group('Fonctionnalités');
  tab('ai','Assistant IA','ai','assistant openai modèle clé api');
  tab('connections','Connexions','apps',client ? 'comptes serveur distant espace' : 'comptes serveur distant espace mcp');
  if (client) tab('mcp','Blok MCP','connections','accès jetons codex clients serveur');
  tab('emojis','Émojis','emoji','emoji image icône logo');
  if (reactGrabAvailable) tab('developer','Développeur','connections','react grab inspecter composant sélection source');
  if (currentWorkspace.kind === 'remote' && options.teamPages) {
    group('Organisation');
    tab('teams','Espaces d’équipe','people','teamspaces groupes membres équipes propriétaires accès',IconBuilding);
  }
  const normalize = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  const headingHasVisibleItem = (heading: HTMLElement): boolean => {
    const walk = { sibling: heading.nextElementSibling };
    while (walk.sibling && !walk.sibling.hasAttribute('data-desktop-settings-nav-heading')) {
      if (walk.sibling instanceof HTMLButtonElement && !walk.sibling.hidden) return true;
      walk.sibling = walk.sibling.nextElementSibling;
    }
    return false;
  };
  const filterNav = (): void => {
    const terms = normalize(search.value.trim()).split(/\s+/);
    for (const [button, keywords] of navEntries) {
      const label = normalize(`${button.textContent} ${keywords}`);
      button.hidden = !terms.every((term) => label.includes(term));
    }
    for (const heading of navList.querySelectorAll<HTMLElement>('[data-desktop-settings-nav-heading]')) {
      heading.hidden = !headingHasVisibleItem(heading);
    }
    noResults.hidden = Boolean(navList.querySelector('[data-desktop-settings-nav-item]:not([hidden])'));
  };
  if (sessionInfo && !onDevice) {
    void sessionInfo.then((session) => {
      const name = session.user.name?.trim() || session.user.email;
      if (name) updateAccountName(name);
      if (!session.user.instanceAdmin) return;
      const instanceHeading = el('div', 'data-desktop-settings-nav-heading', 'Instance');
      const instanceGeneralTab = actionButton('data-desktop-settings-nav-item', 'Général', 'storage');
      const instanceAccessTab = actionButton('data-desktop-settings-nav-item', 'Accès', 'settings');
      const instanceAccountsTab = actionButton('data-desktop-settings-nav-item', 'Comptes', 'profile');
      const instanceWorkspacesTab = actionButton('data-desktop-settings-nav-item', 'Espaces', 'storage');
      const instanceHealthTab = actionButton('data-desktop-settings-nav-item', 'Santé et e-mail', 'connections');
      for (const tab of [instanceGeneralTab, instanceAccessTab, instanceAccountsTab, instanceWorkspacesTab, instanceHealthTab]) {
        tab.setAttribute('data-instance-panel', '');
      }
      navList.append(instanceHeading, instanceGeneralTab, instanceAccessTab, instanceAccountsTab, instanceWorkspacesTab, instanceHealthTab);
      panelTabs.set('instance-general', instanceGeneralTab);
      panelTabs.set('instance-access', instanceAccessTab);
      panelTabs.set('instance-accounts', instanceAccountsTab);
      panelTabs.set('instance-workspaces', instanceWorkspacesTab);
      panelTabs.set('instance-health', instanceHealthTab);
      navEntries.push(
        [instanceGeneralTab, 'instance général nom adresse versions'],
        [instanceAccessTab, 'instance accès inscription signup politique espaces'],
        [instanceAccountsTab, 'instance comptes utilisateurs administrateurs'],
        [instanceWorkspacesTab, 'instance espaces workspaces métadonnées'],
        [instanceHealthTab, 'instance santé email smtp test livraison'],
      );
      instanceGeneralTab.addEventListener('click', () => showPanel('instance-general'));
      instanceAccessTab.addEventListener('click', () => showPanel('instance-access'));
      instanceAccountsTab.addEventListener('click', () => showPanel('instance-accounts'));
      instanceWorkspacesTab.addEventListener('click', () => showPanel('instance-workspaces'));
      instanceHealthTab.addEventListener('click', () => showPanel('instance-health'));
      filterNav();
    }).catch(() => { /* Session unavailable: no Instance rubrique. */ });
  }
  search.addEventListener('input', filterNav);
  search.addEventListener('keydown', (event) => {
    if (event.isComposing || !['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const results = navList.querySelectorAll<HTMLButtonElement>('button:not([hidden])');
    if (event.key === 'Enter') results[0]?.click();
    else results[event.key === 'ArrowDown' ? 0 : results.length - 1]?.focus();
  });
  navList.addEventListener('keydown', (event) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const rows = [...navList.querySelectorAll<HTMLButtonElement>('button:not([hidden])')];
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
  const sections = el('button', 'data-desktop-settings-sections', 'Rubriques');
  sections.type = 'button';
  nav.id = 'settings-nav-' + crypto.randomUUID();
  sections.setAttribute('aria-controls', nav.id);
  const showSections = (expanded: boolean) => {
    dialog.toggleAttribute('data-show-sections', expanded);
    sections.setAttribute('aria-expanded', String(expanded));
    if (expanded) search.focus();
  };
  sections.addEventListener('click', () => {
    const open = !dialog.hasAttribute('data-show-sections');
    showSections(open);
    if (!open) sections.focus();
  });
  const close = el('button', 'data-desktop-settings-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Fermer les réglages');
  dialog.append(sections, close, nav, main);
  overlay.append(dialog);
  document.body.append(overlay);

  const closeMenu = (): void => {
    menu.hidden = true;
    switcher.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsideMenu, true);
    document.removeEventListener('keydown', menuKey);
  };
  const outsideMenu = (event: PointerEvent): void => {
    if (event.target instanceof Node && footer.contains(event.target)) return;
    closeMenu();
  };
  const menuKey = (event: KeyboardEvent): void => {
    if (ui.footerPopup?.isShown) return;
    if (event.key === 'Escape' || event.key === 'Tab') { closeMenu(); switcher.focus(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[role=menuitem], [role=menuitemradio]')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const index = current < 0 ? (delta > 0 ? 0 : items.length - 1) : (current + delta + items.length) % items.length;
      items[index]?.focus();
    }
  };
  const openWorkspaceMenu = (keyboard: boolean): void => {
    ui.footerPopup?.hide();
    menu.hidden = false;
    refreshCreationAction?.();
    switcher.setAttribute('aria-expanded', 'true');
    if (keyboard) preferences.focus();
    document.addEventListener('pointerdown', outsideMenu, true);
    document.addEventListener('keydown', menuKey);
  };
  switcher.addEventListener('click', event => {
    if (!menu.hidden) { closeMenu(); return; }
    openWorkspaceMenu(event.detail === 0);
  });
  switcher.addEventListener('keydown', event => {
    if (!menu.hidden || event.key !== 'ArrowDown') return;
    event.preventDefault();
    event.stopPropagation();
    openWorkspaceMenu(true);
  });

  const closeSettings = (): void => { ui.modal?.close(); };
  close.addEventListener('click', closeSettings);

  const showPanel = (panel: SettingsPanel, initialTab?: 'requests' | 'create'): void => {
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
      content.append(el('h1', 'data-desktop-settings-title', 'Développeur'), el('p', 'data-desktop-settings-intro', 'Inspectez les composants de l’interface de Blok.'));
      const feedback = el('div', 'data-desktop-settings-feedback');
      feedback.setAttribute('data-react-grab-ignore', '');
      const grab = actionButton('data-desktop-settings-grab', 'Sélectionner un élément', 'connections');
      const hint = el('small', 'data-desktop-settings-grab-hint', 'React Grab · ⌘/Ctrl + ⇧ + G');
      grab.addEventListener('click', () => {
        grab.disabled = true;
        void loadReactGrab().then((api) => { api.activate(); hint.textContent = 'Sélectionnez un élément, puis collez-le dans le chat.'; })
          .catch(() => { hint.textContent = 'Chargement impossible. Réessayez.'; }).finally(() => { grab.disabled = false; });
      });
      feedback.append(grab, hint); content.append(feedback);
    } else if (panel === 'notifications' || panel === 'sidebar') {
      ui.choices.push(mountShellNavigationSettings(content,panel === 'notifications' ? {kind:panel}
        : {kind:panel, sidebar:options.sidebarPreferences ?? createSidebarPreferences(workspaceKey(currentWorkspace), true)}));
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
    } else if (panel === 'mcp' && client) {
      mountMcpSettings(content, client);
    } else if (panel === 'connections') {
      content.append(el('h1', 'data-desktop-settings-title', 'Connexions'), el('p', 'data-desktop-settings-intro', 'Gérez vos comptes et connectez vos outils à Blok.'));
      const accounts = el('section', 'data-desktop-connections-accounts');
      const labels = el('div', 'data-desktop-settings-row-labels');
      labels.append(el('strong', 'data-desktop-settings-row-title', offlineProfile ? 'Serveur distant' : 'Comptes et espaces'), el('span', 'data-desktop-settings-row-help', offlineProfile ? 'Accédez aux espaces d’un autre serveur Blok.' : 'Ouvrez un autre espace ou connectez-vous avec une autre adresse.'));
      const manage = actionButton('data-desktop-settings-copy', offlineProfile ? 'Se connecter à un serveur distant' : client ? 'Gérer les comptes' : 'Se connecter', 'profile');
      manage.addEventListener('click', () => { closeSettings(); emitCloud('account'); });
      accounts.append(labels, manage); content.append(accounts);
      if (native && (currentWorkspace.kind === 'local' || !currentWorkspace.embedded)) {
        const server = el('section', 'data-desktop-connections-accounts');
        const info = el('div', 'data-desktop-settings-row-labels');
        void embeddedServerAvailable().then(available => {
          if (!content.isConnected || (!available && currentWorkspace.kind === 'remote' && currentWorkspace.server === LOCAL_SERVER_ORIGIN)) return;
          info.append(el('strong', 'data-desktop-settings-row-title', 'Serveur sur cet ordinateur'),
            el('span', 'data-desktop-settings-row-help', available ? 'Serveur intégré à Blok' : LOCAL_SERVER_ORIGIN + ' · Docker'));
          const open = actionButton('data-desktop-settings-copy', available ? 'Ouvrir le serveur intégré' : 'Ouvrir le serveur local', 'connections');
          open.addEventListener('click', () => { closeSettings(); emitCloud(available ? 'embedded-server' : 'local-server'); });
          server.append(info, open); content.append(server);
        });
      }
      main.append(content);
      return;
    }
    if (panel === 'emojis') {
      content.append(el('h1', 'data-desktop-settings-title', 'Émojis'));
      ui.choices.push(mountCustomEmojiSettings(content, currentWorkspace));
      main.append(content);
      return;
    }
    if (panel === 'members' && admin && client && currentWorkspace.kind === 'remote') {
      content.append(el('h1', 'data-desktop-settings-title', 'Membres'));
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
      const switcherName = switcher.querySelector('[data-desktop-switcher-name]');
      ui.choices.push(mountSettingsPanel(content, {
        kind: 'local', name: switcherName?.textContent || currentWorkspace.name,
        rename(next) {
          if (currentWorkspace.id === 'default') localStorage.setItem('blok:desktop:profile-name', next);
          else rememberWorkspace({...currentWorkspace, name: next});
          updateAccountName(next);
          if (switcherName) switcherName.textContent = next;
          avatar.textContent = Array.from(next)[0]?.toLocaleUpperCase() || 'B';
          const menuAvatar = account.querySelector('[data-desktop-menu-avatar]');
          if (menuAvatar) menuAvatar.textContent = avatar.textContent;
          const accountTitle = account.querySelector('[data-desktop-menu-title]');
          if (accountTitle) accountTitle.textContent = next;
        },
      }));
    } else if (panel === 'preferences') {
      ui.choices.push(mountSettingsPanel(content, {
        kind: 'preferences', appearance: readAppearance(),
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
    if (!fromShortcut) switcher.focus();
    overlay.hidden = false;
    ui.modal = openModalDialog({
      content: overlay, surface: dialog, label: 'Paramètres', initialFocus: () => fromShortcut && search.getClientRects().length ? search : dialog,
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
    else if (section === 'members' && admin) openSettings('members');
    else if ((section === 'teams' || section === 'teams-create') && panelTabs.has('teams')) openSettings('teams', section === 'teams-create' ? 'create' : undefined);
    else openSettings('general');
  });
  preferences.addEventListener('click', () => openSettings('preferences'));
  account.addEventListener('click', () => openSettings('account'));
  const profileName = localProfileName || currentWorkspace.name;
  if (profileName) {
    const switcherName = switcher.querySelector('[data-desktop-switcher-name]');
    if (switcherName) switcherName.textContent = profileName;
    avatar.textContent = Array.from(profileName)[0]?.toLocaleUpperCase() || 'B';
    const menuAvatar = account.querySelector('[data-desktop-menu-avatar]');
    if (menuAvatar) menuAvatar.textContent = avatar.textContent;
    const accountTitle = account.querySelector('[data-desktop-menu-title]');
    if (accountTitle) accountTitle.textContent = profileName;
  }
  if (currentWorkspace.kind === 'remote') {
    switcher.setAttribute('aria-label', 'Espaces et réglages');
  }
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
  }, {once:true});
  return footer;
}
||||||| f8ef3c6b39
=======
import { WORKSPACE_ROLES } from './access-vocabulary';
import { createChoice, styleTextField, wrapSearchField } from './ui/controls';
import { openModalDialog, type ModalDialogHandle } from '@blok/modal-dialog';
import { PopoverDesktop } from '@blok/popover';
import { CloudClient } from './cloud/client';
import { nativeSessionAdapter } from './native-session';
import { mountWorkspaceMembers, openWorkspaceInvitation } from './cloud/workspace-settings';
import { activeWorkspace, listWorkspaces, createLocalWorkspace, workspaceKey, rememberWorkspace } from './workspace-registry';
import { dataDirectory } from './storage';
import corePackage from '../../package.json';
import appPackage from '../package.json';
import { mountAiSettings } from './ai-settings';
import { mountCustomEmojiSettings } from './custom-emoji-settings';
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
  if (panel === 'emojis') return 'custom-emoji-settings.ts';
  if (panel === 'connections') return 'mcp-settings.ts';
  if (panel === 'ai') return 'ai-settings.ts';
  if (panel === 'members') return 'cloud/workspace-settings.ts';
  if (panel.startsWith('instance-')) return 'instance/instance-settings.ts';
  return 'settings.ts';
}

function showShortcutsDialog(): void {
  const overlay = el('div', 'data-desktop-settings-overlay');
  overlay.setAttribute('data-desktop-shortcuts-dialog', '');
  const surface = el('section', 'data-desktop-shortcuts-surface');
  surface.append(
    el('h2', 'data-desktop-settings-title', 'Raccourcis Blok'),
    el('p', 'data-desktop-settings-intro', '/ — boîte à outils'),
    el('p', 'data-desktop-settings-intro', 'Tab / Maj+Tab — imbriquer / désimbriquer'),
    el('p', 'data-desktop-settings-intro', '@ — mentionner une page ou une date'),
    el('p', 'data-desktop-settings-intro', '⌘/Ctrl+K — rechercher une page'),
    el('p', 'data-desktop-settings-intro', '⌘/Ctrl+Z — annuler'),
  );
  const close = el('button', 'data-desktop-settings-copy', 'Fermer');
  close.type = 'button';
  surface.append(close);
  overlay.append(surface);
  const handle = openModalDialog({
    content: overlay,
    surface,
    label: 'Raccourcis Blok',
    initialFocus: () => close,
    onDismiss: () => handle.close(),
  });
  close.addEventListener('click', () => handle.close());
}

function openLocalWorkspaceDialog(onCreate: (name: string) => void): void {
  const overlay = el('div', 'data-desktop-settings-overlay');
  const surface = el('section', 'data-desktop-shortcuts-surface');
  surface.append(el('h2', 'data-desktop-settings-title', 'Nouvel espace local'));
  const form = document.createElement('form');
  const name = el('input', 'data-desktop-settings-name');
  name.type = 'text';
  styleTextField(name);
  name.placeholder = 'Nom de l’espace';
  name.required = true;
  name.maxLength = 80;
  const actions = el('div', 'data-desktop-account-actions');
  const cancel = el('button', 'data-desktop-settings-copy', 'Annuler');
  cancel.type = 'button';
  const submit = el('button', 'data-desktop-settings-copy', 'Créer');
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(name, actions);
  surface.append(form);
  overlay.append(surface);
  const handle = openModalDialog({
    content: overlay,
    surface,
    label: 'Nouvel espace local',
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

type MenuIcon = 'profile' | 'settings' | 'ai' | 'storage' | 'connections' | 'emoji' | 'help';

function menuIcon(kind: MenuIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const paths: Record<MenuIcon, string> = {
    profile: 'M10 10.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2ZM3.7 16.5c.3-2.8 2.7-4.6 6.3-4.6s6 1.8 6.3 4.6H3.7Z',
    settings: 'M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4',
    ai: 'M10 2.5l1.6 5.1L17 9.2l-5.4 1.6L10 16l-1.6-5.2L3 9.2l5.4-1.6L10 2.5ZM16.5 14.3l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5.5-1.2Z',
    connections: 'M8 12l4-4M7 13l-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M13 7l1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0',
    emoji: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM7 8h.01M13 8h.01M7 12c1.5 2 4.5 2 6 0',
    storage: 'M3 5.2h5l1.3 1.5H17v8.1H3V5.2Z',
    help: 'M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM10 14.2h.01M8.4 7.6a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.9.7-.9 1.3v.4',
  };
  path.setAttribute('d', paths[kind]);
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

export function createDesktopFooter(onThemeChange: (mode: Appearance) => void): HTMLElement {
  const currentWorkspace = activeWorkspace();
  const native = '__TAURI_INTERNALS__' in window;
  const admin = currentWorkspace.kind === 'remote' && currentWorkspace.role === 'admin';
  const client = currentWorkspace.kind === 'remote' ? new CloudClient({origin: currentWorkspace.server, sessionAdapter: native ? nativeSessionAdapter(currentWorkspace.server) : undefined}) : null;
  const ui = {
    members: null as ReturnType<typeof mountWorkspaceMembers> | null,
    instancePanel: null as ReturnType<typeof mountInstanceSettings> | null,
    modal: null as ModalDialogHandle | null,
    choices: [] as Array<{destroy(): void}>,
    panelGeneration: 0,
    helpPopup: null as PopoverDesktop | null,
    supportEmail: null as string | null,
    directory: 'Chargement…',
  };
  const openInvitation = (container?: HTMLElement): void => {
    if (!admin || !client || currentWorkspace.kind !== 'remote') return;
    if (!container) switcher.focus();
    openWorkspaceInvitation({client, slug: currentWorkspace.workspaceId, workspaceName: currentWorkspace.name, container, onComplete: () => ui.members?.refresh()});
  };
  const footer = el('div', 'data-desktop-footer');
  const switcher = el('button', 'data-desktop-switcher');
  switcher.type = 'button';
  switcher.setAttribute('aria-label', 'Espace local et réglages');
  switcher.setAttribute('aria-haspopup', 'menu');
  switcher.setAttribute('aria-expanded', 'false');
  switcher.append(el('span', 'data-desktop-avatar', 'B'), el('span', 'data-desktop-switcher-name', 'Espace local'), chevron());
  footer.append(switcher);

  const menu = el('div', 'data-desktop-footer-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const account = currentWorkspace.kind === 'remote' ? el('div', 'data-desktop-menu-account') : el('button', 'data-desktop-menu-account');
  if (account instanceof HTMLButtonElement) { account.type = 'button'; account.setAttribute('role', 'menuitem'); }
  account.append(el('span', 'data-desktop-menu-avatar', currentWorkspace.name.charAt(0).toLocaleUpperCase()));
  const accountText = el('span', 'data-desktop-menu-account-text');
  accountText.append(el('strong', 'data-desktop-menu-title', 'Espace local'), el('small', 'data-desktop-menu-subtitle', 'Données sur cet appareil'));
  account.append(accountText);
  const preferences = actionButton('data-desktop-menu-item', 'Paramètres', 'settings');
  preferences.setAttribute('role', 'menuitem');
  const help = actionButton('data-desktop-menu-help', 'Aide', 'help');
  help.setAttribute('data-desktop-menu-item', '');
  help.setAttribute('role', 'menuitem');
  help.setAttribute('aria-haspopup', 'menu');
  if (client) {
    void client.session().then((session) => {
      // The address a member is told to contact, served by /api/session: the
      // longest-standing instance administrator. Never the viewer's own inbox,
      // and the entry is hidden rather than shown disabled when there is none.
      const support = session.supportEmail ?? '';
      ui.supportEmail = support && support !== session.user.email ? support : null;
    }).catch(() => { /* no support address */ });
  }
  const openHelp = (): void => {
    if (ui.helpPopup?.isShown) { ui.helpPopup.hide(); return; }
    const workspaceId = currentWorkspace.kind === 'remote' ? currentWorkspace.workspaceId : currentWorkspace.id;
    const items = [
      {
        name: 'getting-started',
        title: 'Premiers pas',
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
        title: 'Qui peut voir quoi',
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
        title: 'Raccourcis',
        closeOnActivate: true,
        onActivate: () => {
          showShortcutsDialog();
        },
      },
      // Omitted when the instance has no address to offer: a permanently
      // greyed row teaches nothing and reads as broken.
      ...(ui.supportEmail ? [{
        name: 'report',
        title: 'Signaler un problème',
        closeOnActivate: true,
        onActivate: () => {
          const address = ui.supportEmail;
          if (!address) return;
          location.href = `mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent('Signaler un problème — Blok')}`;
        },
      }] : []),
      {
        name: 'version',
        title: `Blok ${CORE_VERSION} · App ${APP_VERSION}`,
        isDisabled: true,
        onActivate: () => undefined,
      },
    ];
    const popup = new PopoverDesktop({
      trigger: help,
      width: 'auto',
      minWidth: '220px',
      items,
      class: 'desktop-help-popover',
    });
    popup.getElement().setAttribute('data-desktop-help-popover', '');
    const palette = getComputedStyle(help);
    for (const token of ['--blok-popover-bg', '--blok-popover-border', '--blok-text-primary', '--blok-text-secondary', '--blok-item-hover-bg']) {
      const value = palette.getPropertyValue(token);
      if (value) popup.getElement().style.setProperty(token, value);
    }
    ui.helpPopup = popup;
    const closed = { settled: false };
    popup.on('closed', () => {
      if (closed.settled) return;
      closed.settled = true;
      if (ui.helpPopup === popup) ui.helpPopup = null;
      queueMicrotask(() => popup.destroy());
    });
    popup.show();
  };
  help.addEventListener('click', () => { openHelp(); });
  const emitCloud = (section: 'settings' | 'invites' | 'account'): void => {
    closeMenu();
    footer.dispatchEvent(new CustomEvent('blok:desktop-connect-cloud', {bubbles: true, detail: {section}}));
  };
  const connect = actionButton('data-desktop-menu-connect', currentWorkspace.kind === 'remote' ? 'Gérer mon compte' : 'Ajouter un compte', 'profile');
  connect.setAttribute('data-desktop-menu-item', '');
  connect.setAttribute('role', 'menuitem');
  connect.addEventListener('click', () => {
    if (currentWorkspace.kind === 'remote') openSettings('account');
    else emitCloud('account');
  });
  menu.append(account, preferences, help);
  if (admin) {
    const invite = actionButton('data-desktop-menu-invite', 'Inviter des membres', 'profile');
    invite.setAttribute('data-desktop-menu-item', '');
    invite.setAttribute('role', 'menuitem');
    invite.addEventListener('click', () => { closeMenu(); openInvitation(); });
    menu.append(invite);
  }
  menu.append(connect);
  const all = listWorkspaces();
  const remote = all.filter((ref) => ref.kind === 'remote');
  const groups = new Map<string, typeof remote>();
  for (const ref of remote) {
    const email = ref.userName ?? 'Compte en ligne';
    const members = groups.get(email) ?? [];
    members.push(ref); groups.set(email, members);
  }
  const addChoice = (ref: (typeof all)[number], group: HTMLElement): void => {
    const choice = actionButton('data-desktop-menu-workspace', ref.name, 'storage');
    const label = el('span', 'data-desktop-menu-workspace-name', ref.name);
    choice.replaceChildren(el('span', 'data-desktop-workspace-avatar', ref.name.charAt(0).toLocaleUpperCase()), label);
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
    menu.append(group);
  }
  if (native) {
    const group = el('div', 'data-desktop-menu-group');
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Sur cet appareil');
    group.append(el('div', 'data-desktop-menu-group-label', 'Sur cet appareil'));
    for (const ref of all.filter((item) => item.kind === 'local')) addChoice(ref, group);
    const addLocal = actionButton('data-desktop-menu-new-workspace', 'Créer un espace local', 'storage');
    addLocal.setAttribute('data-desktop-menu-item', ''); addLocal.setAttribute('role', 'menuitem');
    addLocal.addEventListener('click', () => {
      closeMenu();
      openLocalWorkspaceDialog((name) => {
        footer.dispatchEvent(new CustomEvent('blok:desktop-select-workspace', {bubbles: true, detail: createLocalWorkspace(name)}));
      });
    });
    group.append(addLocal); menu.append(group);
  }
  footer.append(menu);

  const overlay = el('div', 'data-desktop-settings-overlay');
  overlay.hidden = true;
  const dialog = el('div', 'data-desktop-settings-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Réglages');
  dialog.tabIndex = -1;
  const nav = el('aside', 'data-desktop-settings-nav');
  nav.setAttribute('aria-label', 'Rubriques des réglages');
  const search = el('input', 'data-desktop-settings-search');
  search.type = 'search'; search.placeholder = 'Rechercher…';
  search.setAttribute('aria-label', 'Rechercher dans les réglages');
  const searchBox = wrapSearchField(search);
  const navList = el('div', 'data-desktop-settings-nav-list');
  const noResults = el('p', 'data-desktop-settings-no-results', 'Aucune rubrique trouvée.');
  noResults.hidden = true; noResults.setAttribute('role', 'status');
  nav.append(searchBox, navList, noResults);
  navList.append(el('div', 'data-desktop-settings-nav-heading', 'Compte'));
  const accountTab = actionButton('data-desktop-settings-nav-item', currentWorkspace.kind === 'remote' ? currentWorkspace.userName ?? 'Mon compte' : 'Profil local', 'profile');
  const connectionsTab = actionButton('data-desktop-settings-nav-item', 'Connexions', 'connections');
  navList.append(accountTab);
  navList.append(connectionsTab);
  navList.append(el('div', 'data-desktop-settings-nav-heading', 'Application'));
  const prefsTab = actionButton('data-desktop-settings-nav-item', 'Préférences', 'settings');
  const aiTab = actionButton('data-desktop-settings-nav-item', 'Assistant IA', 'ai');
  navList.append(prefsTab, aiTab);
  const generalTab = actionButton('data-desktop-settings-nav-item', 'Général', 'storage');
  const emojiTab = actionButton('data-desktop-settings-nav-item', 'Émojis', 'emoji');
  const membersTab = actionButton('data-desktop-settings-nav-item', 'Membres', 'profile');
  navList.append(el('div', 'data-desktop-settings-nav-heading', 'Espace'), generalTab, emojiTab);
  if (admin) navList.append(membersTab);
  const navEntries: Array<[HTMLButtonElement, string]> = [
    [accountTab, 'compte profil identité email'], [connectionsTab, 'connexion mcp jeton compte serveur espace'],
    [prefsTab, 'préférences apparence thème clair sombre'], [aiTab, 'assistant ia openai modèle clé api'],
    [generalTab, 'général espace nom stockage'], [emojiTab, 'émoji emoji image icône logo'], [membersTab, 'membres invitations accès rôles'],
  ];
  type SettingsPanel =
    | 'account' | 'preferences' | 'ai' | 'general' | 'members' | 'emojis' | 'connections'
    | 'instance-general' | 'instance-access' | 'instance-accounts' | 'instance-workspaces' | 'instance-health';
  const panelTabs = new Map<SettingsPanel, HTMLButtonElement>([
    ['account', accountTab], ['connections', connectionsTab], ['preferences', prefsTab], ['ai', aiTab],
    ['general', generalTab], ['emojis', emojiTab], ['members', membersTab],
  ]);
  const normalize = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  const headingHasVisibleItem = (heading: HTMLElement): boolean => {
    const walk = { sibling: heading.nextElementSibling };
    while (walk.sibling && !walk.sibling.hasAttribute('data-desktop-settings-nav-heading')) {
      if (walk.sibling instanceof HTMLButtonElement && !walk.sibling.hidden) return true;
      walk.sibling = walk.sibling.nextElementSibling;
    }
    return false;
  };
  const filterNav = (): void => {
    const query = normalize(search.value.trim());
    for (const [button, keywords] of navEntries) button.hidden = !normalize(`${button.textContent} ${keywords}`).includes(query);
    for (const heading of navList.querySelectorAll<HTMLElement>('[data-desktop-settings-nav-heading]')) {
      heading.hidden = !headingHasVisibleItem(heading);
    }
    noResults.hidden = Boolean(navList.querySelector('[data-desktop-settings-nav-item]:not([hidden])'));
  };
  if (client) {
    void client.session().then((session) => {
      if (!session.user.instanceAdmin) return;
      const instanceHeading = el('div', 'data-desktop-settings-nav-heading', 'Instance');
      const instanceGeneralTab = actionButton('data-desktop-settings-nav-item', 'Général', 'storage');
      const instanceAccessTab = actionButton('data-desktop-settings-nav-item', 'Accès', 'settings');
      const instanceAccountsTab = actionButton('data-desktop-settings-nav-item', 'Comptes', 'profile');
      const instanceWorkspacesTab = actionButton('data-desktop-settings-nav-item', 'Espaces', 'storage');
      const instanceHealthTab = actionButton('data-desktop-settings-nav-item', 'Santé et e-mail', 'connections');
      for (const tab of [instanceGeneralTab, instanceAccessTab, instanceAccountsTab, instanceWorkspacesTab, instanceHealthTab]) {
        tab.setAttribute('data-instance-panel', '');
      }
      navList.append(instanceHeading, instanceGeneralTab, instanceAccessTab, instanceAccountsTab, instanceWorkspacesTab, instanceHealthTab);
      panelTabs.set('instance-general', instanceGeneralTab);
      panelTabs.set('instance-access', instanceAccessTab);
      panelTabs.set('instance-accounts', instanceAccountsTab);
      panelTabs.set('instance-workspaces', instanceWorkspacesTab);
      panelTabs.set('instance-health', instanceHealthTab);
      navEntries.push(
        [instanceGeneralTab, 'instance général nom adresse versions'],
        [instanceAccessTab, 'instance accès inscription signup politique espaces'],
        [instanceAccountsTab, 'instance comptes utilisateurs administrateurs'],
        [instanceWorkspacesTab, 'instance espaces workspaces métadonnées'],
        [instanceHealthTab, 'instance santé email smtp test livraison'],
      );
      instanceGeneralTab.addEventListener('click', () => showPanel('instance-general'));
      instanceAccessTab.addEventListener('click', () => showPanel('instance-access'));
      instanceAccountsTab.addEventListener('click', () => showPanel('instance-accounts'));
      instanceWorkspacesTab.addEventListener('click', () => showPanel('instance-workspaces'));
      instanceHealthTab.addEventListener('click', () => showPanel('instance-health'));
      filterNav();
    }).catch(() => { /* Session unavailable: no Instance rubrique. */ });
  }
  search.addEventListener('input', filterNav);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); navList.querySelector<HTMLButtonElement>('button:not([hidden])')?.click(); }
  });
  if (reactGrabAvailable) {
    const feedback = el('div', 'data-desktop-settings-feedback');
    feedback.setAttribute('data-react-grab-ignore', '');
    const grab = actionButton('data-desktop-settings-grab', 'Sélectionner un élément', 'connections');
    const hint = el('small', 'data-desktop-settings-grab-hint', 'React Grab · ⌘/Ctrl + ⇧ + G');
    grab.addEventListener('click', () => {
      grab.disabled = true;
      void loadReactGrab().then((api) => { api.activate(); hint.textContent = 'Sélectionnez un élément, puis collez-le dans le chat.'; })
        .catch(() => { hint.textContent = 'Chargement impossible. Réessayez.'; }).finally(() => { grab.disabled = false; });
    });
    feedback.append(grab, hint); nav.append(feedback);
  }
  const main = el('main', 'data-desktop-settings-main');
  const close = el('button', 'data-desktop-settings-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Fermer les réglages');
  main.append(close);
  dialog.append(nav, main);
  overlay.append(dialog);
  document.body.append(overlay);

  if (native && currentWorkspace.kind === 'local') void dataDirectory().then((value) => {
    ui.directory = value;
    const path = overlay.querySelector('[data-desktop-settings-path]');
    if (path) path.textContent = value;
  }).catch(() => { ui.directory = 'Indisponible'; });

  const closeMenu = (): void => {
    menu.hidden = true;
    switcher.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsideMenu, true);
    document.removeEventListener('keydown', menuKey);
  };
  const outsideMenu = (event: PointerEvent): void => {
    if (event.target instanceof Node && footer.contains(event.target)) return;
    closeMenu();
  };
  const menuKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { closeMenu(); switcher.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[role=menuitem], [role=menuitemradio]')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + delta + items.length) % items.length]?.focus();
    }
  };
  switcher.addEventListener('click', () => {
    if (!menu.hidden) { closeMenu(); return; }
    menu.hidden = false;
    switcher.setAttribute('aria-expanded', 'true');
    preferences.focus();
    document.addEventListener('pointerdown', outsideMenu, true);
    document.addEventListener('keydown', menuKey);
  });

  const closeSettings = (): void => { ui.modal?.close(); };
  close.addEventListener('click', closeSettings);

  const showPanel = (panel: SettingsPanel): void => {
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
    if (panel === 'connections') {
      content.append(el('h1', 'data-desktop-settings-title', 'Connexions'), el('p', 'data-desktop-settings-intro', 'Gérez vos comptes et connectez vos outils à Blok.'));
      const accounts = el('section', 'data-desktop-connections-accounts');
      const labels = el('div', 'data-desktop-settings-row-labels');
      labels.append(el('strong', 'data-desktop-settings-row-title', 'Comptes et espaces'), el('span', 'data-desktop-settings-row-help', 'Ouvrez un autre espace ou connectez-vous avec une autre adresse.'));
      const manage = actionButton('data-desktop-settings-copy', client ? 'Gérer les comptes' : 'Se connecter', 'profile');
      manage.addEventListener('click', () => { closeSettings(); emitCloud('account'); });
      accounts.append(labels, manage); content.append(accounts);
      main.append(content);
      if (client) mountMcpSettings(content, client, {embedded: true});
      return;
    }
    if (panel === 'emojis') {
      content.append(el('h1', 'data-desktop-settings-title', 'Émojis'));
      ui.choices.push(mountCustomEmojiSettings(content, currentWorkspace));
      main.append(content);
      return;
    }
    if (panel === 'members' && admin && client && currentWorkspace.kind === 'remote') {
      content.append(el('h1', 'data-desktop-settings-title', 'Membres'));
      main.append(content);
      ui.members = mountWorkspaceMembers(content, {client, slug: currentWorkspace.workspaceId, onInvite: () => openInvitation(dialog)});
      return;
    }
    if (panel === 'account' && currentWorkspace.kind === 'remote') {
      content.setAttribute('data-desktop-account', '');
      content.append(el('h1', 'data-desktop-settings-title', 'Mon compte'), el('p', 'data-desktop-settings-intro', 'Votre identité et votre accès à cet espace.'));
      const identity = el('section', 'data-desktop-account-section');
      identity.append(el('h2', 'data-desktop-settings-section', 'Identité'));
      const row = el('div', 'data-desktop-settings-row');
      row.append(el('strong', 'data-desktop-settings-row-title', 'Adresse e-mail'), el('span', 'data-desktop-settings-row-value', currentWorkspace.userName ?? 'Compte en ligne'));
      identity.append(row);
      const workspace = el('section', 'data-desktop-account-section');
      workspace.append(el('h2', 'data-desktop-settings-section', 'Espace actuel'));
      const workspaceRow = el('div', 'data-desktop-settings-row');
      workspaceRow.append(el('strong', 'data-desktop-settings-row-title', 'Nom'), el('span', 'data-desktop-settings-row-value', currentWorkspace.name));
      const roleRow = el('div', 'data-desktop-settings-row');
      roleRow.append(el('strong', 'data-desktop-settings-row-title', 'Rôle'), el('span', 'data-desktop-settings-row-value', WORKSPACE_ROLES[currentWorkspace.role ?? 'member']));
      workspace.append(workspaceRow, roleRow);
      const accounts = actionButton('data-desktop-settings-copy', 'Comptes et espaces', 'profile');
      accounts.addEventListener('click', () => { closeSettings(); emitCloud('account'); });
      const accountActions = el('div', 'data-desktop-account-actions');
      accountActions.append(el('p', 'data-desktop-settings-row-help', 'Retrouvez vos espaces ou connectez un autre compte.'), accounts);
      content.append(identity, workspace, accountActions);
    } else if (panel === 'account') {
      content.append(el('h1', 'data-desktop-settings-title', 'Profil local'));
      content.append(el('p', 'data-desktop-settings-intro', 'Cet espace appartient à cet appareil.'));
      content.append(el('h2', 'data-desktop-settings-section', 'Identité affichée'));
      const row = el('div', 'data-desktop-settings-row');
      const labels = el('div', 'data-desktop-settings-row-labels');
      labels.append(el('strong', 'data-desktop-settings-row-title', 'Nom'), el('span', 'data-desktop-settings-row-help', 'Nom local, sans connexion ni partage.'));
      const name = el('input', 'data-desktop-settings-name');
      name.type = 'text';
      styleTextField(name);
      name.maxLength = 48;
      name.value = currentWorkspace.kind === 'local' && currentWorkspace.id === 'default' ? localStorage.getItem('blok:desktop:profile-name') || 'Espace local' : currentWorkspace.name;

      name.setAttribute('aria-label', 'Nom du profil local');
      name.addEventListener('change', () => {
        const next = name.value.trim() || 'Espace local';
        if (currentWorkspace.kind === 'local' && currentWorkspace.id === 'default') localStorage.setItem('blok:desktop:profile-name', next);
        else rememberWorkspace({...currentWorkspace, name: next});
        const switcherName = switcher.querySelector('[data-desktop-switcher-name]');
        if (switcherName) switcherName.textContent = next;
        const accountTitle = account.querySelector('[data-desktop-menu-title]');
        if (accountTitle) accountTitle.textContent = next;
      });
      row.append(labels, name);
      content.append(row, el('p', 'data-desktop-settings-explanation', 'Pour partager et modifier des pages à plusieurs via Internet, il faudra connecter l’app à un service avec comptes et droits d’accès. Utilisez « Connecter un espace en ligne » dans le menu des espaces.'));
    } else if (panel === 'preferences') {
      content.append(el('h1', 'data-desktop-settings-title', 'Préférences'));
      content.append(el('p', 'data-desktop-settings-intro', 'Personnalisez l’apparence de Blok sur cet appareil.'));
      content.append(el('h2', 'data-desktop-settings-section', 'Apparence'));
      const row = el('div', 'data-desktop-settings-row');
      const labels = el('div', 'data-desktop-settings-row-labels');
      labels.append(el('strong', 'data-desktop-settings-row-title', 'Thème'), el('span', 'data-desktop-settings-row-help', 'Choisissez l’apparence de Blok sur cet appareil.'));
      const theme = createChoice<Appearance>({
        label: 'Thème', value: readAppearance(),
        options: [{value:'dark',label:'Sombre'},{value:'light',label:'Clair'},{value:'auto',label:'Système'}],
        onChange(mode) {
          localStorage.setItem(KEY, mode);
          const root = document.querySelector('[data-desktop-shell]');
          if (root instanceof HTMLElement) applyAppearance(root, mode);
          onThemeChange(mode);
        },
      });
      theme.element.setAttribute('data-desktop-settings-theme', ''); ui.choices.push(theme);
      row.append(labels, theme.element);
      content.append(row);
      if (native && currentWorkspace.kind === 'local') {
        const advanced = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = 'Avancé';
        advanced.append(summary, el('code', 'data-desktop-settings-path', ui.directory));
        const copy = el('button', 'data-desktop-settings-copy', 'Copier le chemin des données'); copy.type = 'button';
        copy.addEventListener('click', () => { void navigator.clipboard.writeText(ui.directory).then(() => { copy.textContent = 'Chemin copié'; }); });
        advanced.append(copy); content.append(advanced);
      }
    } else if (panel === 'ai') {
      ui.choices.push(mountAiSettings(content, currentWorkspace));
    } else if (panel === 'general') {
      content.append(el('h1', 'data-desktop-settings-title', 'Général'), el('p', 'data-desktop-settings-intro', 'Informations sur votre espace.'));
      const nameRow = el('div', 'data-desktop-settings-row');
      nameRow.append(el('strong', 'data-desktop-settings-row-title', 'Nom de l’espace'), el('span', 'data-desktop-settings-row-value', currentWorkspace.name));
      content.append(nameRow);
      if (currentWorkspace.kind === 'remote') {
        const serverRow = el('div', 'data-desktop-settings-row');
        serverRow.append(el('strong', 'data-desktop-settings-row-title', 'Serveur'), el('span', 'data-desktop-settings-row-value', currentWorkspace.server));
        const advanced = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = 'Avancé';
        advanced.append(summary, serverRow); content.append(advanced);
      } else content.append(el('p', 'data-desktop-settings-explanation', 'Les pages de cet espace sont enregistrées sur cet appareil.'));
      content.append(el('p', 'data-desktop-settings-version', `Blok ${CORE_VERSION} · App ${APP_VERSION}`));
    }

    main.append(content);
  };
  accountTab.addEventListener('click', () => showPanel('account'));
  prefsTab.addEventListener('click', () => showPanel('preferences'));
  aiTab.addEventListener('click', () => showPanel('ai'));
  generalTab.addEventListener('click', () => showPanel('general'));
  emojiTab.addEventListener('click', () => showPanel('emojis'));
  connectionsTab.addEventListener('click', () => showPanel('connections'));
  membersTab.addEventListener('click', () => { if (admin) showPanel('members'); });
  const openSettings = (panel: SettingsPanel): void => {
    closeMenu();
    search.value = ''; filterNav();
    showPanel(panel);
    switcher.focus();
    overlay.hidden = false;
    ui.modal = openModalDialog({
      content: overlay, surface: dialog, label: 'Paramètres', initialFocus: () => dialog,
      onDismiss: (reason) => {
        if (reason === 'escape' && document.activeElement === search && search.value) { search.value = ''; filterNav(); return; }
        closeSettings();
      },
      onClose: () => {
        overlay.hidden = true; ++ui.panelGeneration;
        ui.choices.splice(0).forEach((choice) => choice.destroy());
        ui.members?.destroy(); ui.members = null;
        ui.instancePanel?.destroy(); ui.instancePanel = null;
        ui.modal = null;
      },
    });
  };
  footer.addEventListener('blok:desktop-open-ai-settings', () => openSettings('ai'));
  footer.addEventListener('blok:desktop-open-settings', (event) => {
    const section = (event as CustomEvent<string>).detail;
    if (section === 'invites' && admin) { closeMenu(); openInvitation(); }
    else if (section === 'members' && admin) openSettings('members');
    else openSettings('general');
  });
  preferences.addEventListener('click', () => openSettings('preferences'));
  if (account instanceof HTMLButtonElement) account.addEventListener('click', () => openSettings('account'));
  const profileName = currentWorkspace.kind === 'local' && currentWorkspace.id === 'default' ? localStorage.getItem('blok:desktop:profile-name') : currentWorkspace.name;
  if (profileName) {
    const switcherName = switcher.querySelector('[data-desktop-switcher-name]');
    if (switcherName) switcherName.textContent = profileName;
    const accountTitle = account.querySelector('[data-desktop-menu-title]');
    if (accountTitle) accountTitle.textContent = profileName;
  }
  if (currentWorkspace.kind === 'remote') {
    const accountSubtitle = account.querySelector('[data-desktop-menu-subtitle]');
    if (accountSubtitle) accountSubtitle.textContent = currentWorkspace.userName ?? 'Compte en ligne';
    switcher.setAttribute('aria-label', 'Espaces et réglages');
  }
  const pendingSettings = sessionStorage.getItem('blok:desktop:pending-settings');
  if (pendingSettings) {
    sessionStorage.removeItem('blok:desktop:pending-settings');
    queueMicrotask(() => {
      footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', {detail: pendingSettings}));
    });
  }
  return footer;
}
>>>>>>> origin/fix/self-host-review
||||||| f8ef3c6b39
=======
import { dataDirectory } from './storage';
import corePackage from '../../package.json';
import appPackage from '../package.json';
import { providerStatus, selectedProvider, setProvider, type Provider } from './assistant';

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
  return mode === 'auto' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
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

type MenuIcon = 'profile' | 'settings' | 'ai' | 'storage';

function menuIcon(kind: MenuIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const paths: Record<MenuIcon, string> = {
    profile: 'M10 10.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2ZM3.7 16.5c.3-2.8 2.7-4.6 6.3-4.6s6 1.8 6.3 4.6H3.7Z',
    settings: 'M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4',
    ai: 'M10 2.5l1.6 5.1L17 9.2l-5.4 1.6L10 16l-1.6-5.2L3 9.2l5.4-1.6L10 2.5ZM16.5 14.3l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5.5-1.2Z',
    storage: 'M3 5.2h5l1.3 1.5H17v8.1H3V5.2Z',
  };
  path.setAttribute('d', paths[kind]);
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
  button.append(menuIcon(kind), document.createTextNode(label));
  return button;
}

export function createDesktopFooter(onThemeChange: (mode: Appearance) => void): HTMLElement {
  const footer = el('div', 'data-desktop-footer');
  const switcher = el('button', 'data-desktop-switcher');
  switcher.type = 'button';
  switcher.setAttribute('aria-label', 'Espace local et réglages');
  switcher.setAttribute('aria-haspopup', 'menu');
  switcher.setAttribute('aria-expanded', 'false');
  switcher.append(el('span', 'data-desktop-avatar', 'B'), el('span', 'data-desktop-switcher-name', 'Espace local'), chevron());
  footer.append(switcher);

  const menu = el('div', 'data-desktop-footer-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const account = el('button', 'data-desktop-menu-account');
  account.type = 'button';
  account.setAttribute('role', 'menuitem');
  account.append(el('span', 'data-desktop-menu-avatar', 'B'));
  const accountText = el('span', 'data-desktop-menu-account-text');
  accountText.append(el('strong', 'data-desktop-menu-title', 'Espace local'), el('small', 'data-desktop-menu-subtitle', 'Données sur cet appareil'));
  account.append(accountText);
  const preferences = actionButton('data-desktop-menu-item', 'Préférences', 'settings');
  preferences.setAttribute('role', 'menuitem');
  const storage = actionButton('data-desktop-menu-item', 'Copier le chemin des données', 'storage');
  storage.setAttribute('role', 'menuitem');
  menu.append(account, preferences, storage);
  footer.append(menu);

  const overlay = el('div', 'data-desktop-settings-overlay');
  overlay.hidden = true;
  const dialog = el('div', 'data-desktop-settings-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Réglages');
  dialog.tabIndex = -1;
  const nav = el('aside', 'data-desktop-settings-nav');
  nav.append(el('div', 'data-desktop-settings-nav-heading', 'Compte'));
  const accountTab = actionButton('data-desktop-settings-nav-item', 'Profil local', 'profile');
  nav.append(accountTab, el('div', 'data-desktop-settings-nav-heading', 'Application'));
  const prefsTab = actionButton('data-desktop-settings-nav-item', 'Préférences', 'settings');
  const aiTab = actionButton('data-desktop-settings-nav-item', 'Assistant IA', 'ai');
  const dataTab = actionButton('data-desktop-settings-nav-item', 'Données locales', 'storage');
  nav.append(prefsTab, aiTab, dataTab);
  const main = el('main', 'data-desktop-settings-main');
  const close = el('button', 'data-desktop-settings-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Fermer les réglages');
  main.append(close);
  dialog.append(nav, main);
  overlay.append(dialog);
  document.body.append(overlay);

  let directory = 'Chargement…';
  void dataDirectory().then((value) => {
    directory = value;
    const path = overlay.querySelector('[data-desktop-settings-path]');
    if (path) path.textContent = value;
  }).catch(() => { directory = 'Indisponible'; });

  const closeMenu = (): void => {
    menu.hidden = true;
    switcher.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsideMenu, true);
    document.removeEventListener('keydown', menuKey);
  };
  const outsideMenu = (event: PointerEvent): void => {
    if (event.target instanceof Node && footer.contains(event.target)) return;
    closeMenu();
  };
  const menuKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { closeMenu(); switcher.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [preferences, storage];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + delta + items.length) % items.length]?.focus();
    }
  };
  switcher.addEventListener('click', () => {
    if (!menu.hidden) { closeMenu(); return; }
    menu.hidden = false;
    switcher.setAttribute('aria-expanded', 'true');
    preferences.focus();
    document.addEventListener('pointerdown', outsideMenu, true);
    document.addEventListener('keydown', menuKey);
  });

  const closeSettings = (): void => {
    overlay.hidden = true;
    document.removeEventListener('keydown', settingsKey);
    switcher.focus();
  };
  const settingsKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { closeSettings(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button, select, input:not(:disabled)')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  close.addEventListener('click', closeSettings);
  overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) closeSettings(); });

  const showPanel = (panel: 'account' | 'preferences' | 'ai' | 'data'): void => {
    accountTab.setAttribute('aria-current', panel === 'account' ? 'page' : 'false');
    prefsTab.setAttribute('aria-current', panel === 'preferences' ? 'page' : 'false');
    aiTab.setAttribute('aria-current', panel === 'ai' ? 'page' : 'false');
    dataTab.setAttribute('aria-current', panel === 'data' ? 'page' : 'false');
    main.querySelector('[data-desktop-settings-content]')?.remove();
    const content = el('div', 'data-desktop-settings-content');
    if (panel === 'account') {
      content.append(el('h1', 'data-desktop-settings-title', 'Profil local'));
      content.append(el('p', 'data-desktop-settings-intro', 'Cet espace appartient à cet appareil. Aucun compte en ligne n’est connecté.'));
      content.append(el('h2', 'data-desktop-settings-section', 'Identité affichée'));
      const row = el('div', 'data-desktop-settings-row');
      const labels = el('div', 'data-desktop-settings-row-labels');
      labels.append(el('strong', 'data-desktop-settings-row-title', 'Nom'), el('span', 'data-desktop-settings-row-help', 'Nom local, sans connexion ni partage.'));
      const name = el('input', 'data-desktop-settings-name');
      name.type = 'text';
      name.maxLength = 48;
      name.value = localStorage.getItem('blok:desktop:profile-name') || 'Espace local';
      name.setAttribute('aria-label', 'Nom du profil local');
      name.addEventListener('change', () => {
        const next = name.value.trim() || 'Espace local';
        localStorage.setItem('blok:desktop:profile-name', next);
        switcher.querySelector('[data-desktop-switcher-name]')!.textContent = next;
        account.querySelector('[data-desktop-menu-title]')!.textContent = next;
      });
      row.append(labels, name);
      content.append(row, el('p', 'data-desktop-settings-explanation', 'Pour partager et modifier des pages à plusieurs via Internet, il faudra connecter l’app à un service avec comptes et droits d’accès. Cette connexion n’est pas encore disponible.'));
    } else if (panel === 'preferences') {
      content.append(el('h1', 'data-desktop-settings-title', 'Préférences'));
      content.append(el('p', 'data-desktop-settings-intro', 'Personnalisez l’apparence de Blok sur cet appareil.'));
      content.append(el('h2', 'data-desktop-settings-section', 'Apparence'));
      const row = el('div', 'data-desktop-settings-row');
      const labels = el('div', 'data-desktop-settings-row-labels');
      labels.append(el('strong', 'data-desktop-settings-row-title', 'Thème'), el('span', 'data-desktop-settings-row-help', 'Choisissez l’apparence de Blok sur cet appareil.'));
      const select = el('select', 'data-desktop-settings-theme');
      select.setAttribute('aria-label', 'Thème');
      for (const [value, label] of [['dark', 'Sombre'], ['light', 'Clair'], ['auto', 'Système']] as const) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.append(option);
      }
      select.value = readAppearance();
      select.addEventListener('change', () => {
        const mode = select.value as Appearance;
        localStorage.setItem(KEY, mode);
        const root = document.querySelector('[data-desktop-shell]');
        if (root instanceof HTMLElement) applyAppearance(root, mode);
        onThemeChange(mode);
      });
      row.append(labels, select);
      content.append(row);
    } else if (panel === 'ai') {
      content.append(el('h1', 'data-desktop-settings-title', 'Assistant IA'));
      content.append(el('p', 'data-desktop-settings-intro', 'Utilise les agents installés et connectés sur ce Mac. Les identifiants restent dans leurs outils.'));
      content.append(el('h2', 'data-desktop-settings-section', 'Fournisseur'));
      for (const provider of ['codex', 'claude'] as const) {
        const row = el('div', 'data-desktop-settings-row');
        const labels = el('div', 'data-desktop-settings-row-labels');
        labels.append(el('strong', 'data-desktop-settings-row-title', provider === 'codex' ? 'Codex' : 'Claude Code'));
        const status = el('span', 'data-desktop-settings-row-help', 'Vérification…');
        labels.append(status);
        const radio = el('input', 'data-desktop-settings-provider');
        radio.type = 'radio';
        radio.name = 'desktop-ai-provider';
        radio.value = provider;
        radio.checked = selectedProvider() === provider;
        radio.setAttribute('aria-label', `Utiliser ${provider === 'codex' ? 'Codex' : 'Claude Code'}`);
        radio.addEventListener('change', () => { if (radio.checked) setProvider(provider as Provider); });
        row.append(labels, radio);
        content.append(row);
        void providerStatus(provider).then((result) => {
          status.textContent = !result.installed ? 'Non installé' : result.connected ? `Connecté · ${result.version}` : `Non connecté · ${result.version}`;
          radio.disabled = !result.connected;
          if (!result.connected && radio.checked) {
            const fallback = content.querySelector<HTMLInputElement>('[data-desktop-settings-provider][value="codex"]');
            if (fallback && !fallback.disabled) { fallback.checked = true; setProvider('codex'); }
          }
        }).catch((error: unknown) => { status.textContent = `État indisponible : ${String(error)}`; radio.disabled = true; });
      }
      content.append(el('p', 'data-desktop-settings-explanation', 'La demande et, si tu le choisis, le texte de la page sont envoyés à l’agent sélectionné. La connexion de Codex ou Claude Code se fait dans leur CLI.'));
    } else {
      content.append(el('h1', 'data-desktop-settings-title', 'Données locales'));
      content.append(el('p', 'data-desktop-settings-intro', 'Les pages sont enregistrées sur cet appareil.'));
      const path = el('code', 'data-desktop-settings-path', directory);
      const copy = el('button', 'data-desktop-settings-copy', 'Copier le chemin');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(directory).then(() => { copy.textContent = 'Chemin copié'; });
      });
      content.append(path, copy, el('p', 'data-desktop-settings-version', `Blok ${CORE_VERSION} · App ${APP_VERSION}`));
    }
    main.append(content);
  };
  accountTab.addEventListener('click', () => showPanel('account'));
  prefsTab.addEventListener('click', () => showPanel('preferences'));
  aiTab.addEventListener('click', () => showPanel('ai'));
  dataTab.addEventListener('click', () => showPanel('data'));
  const openSettings = (panel: 'account' | 'preferences' | 'ai' | 'data'): void => {
    closeMenu();
    showPanel(panel);
    overlay.hidden = false;
    dialog.focus();
    document.addEventListener('keydown', settingsKey);
  };
  footer.addEventListener('blok:desktop-open-ai-settings', () => openSettings('ai'));
  preferences.addEventListener('click', () => {
    openSettings('preferences');
  });
  account.addEventListener('click', () => openSettings('account'));
  storage.addEventListener('click', () => {
    closeMenu();
    void navigator.clipboard.writeText(directory).then(() => {
      storage.textContent = 'Chemin copié';
      window.setTimeout(() => { storage.replaceChildren(menuIcon('storage'), document.createTextNode('Copier le chemin des données')); }, 1800);
    });
  });
  const profileName = localStorage.getItem('blok:desktop:profile-name');
  if (profileName) {
    switcher.querySelector('[data-desktop-switcher-name]')!.textContent = profileName;
    account.querySelector('[data-desktop-menu-title]')!.textContent = profileName;
  }
  return footer;
}
>>>>>>> origin/feat/desktop-title-date-mentions
