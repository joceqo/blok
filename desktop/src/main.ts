import { listenForPageLinks } from './native-page-links';
import { parsePageLink } from './page-link';
import './editor.css';
import '../../src/shell/sidebar.css';
import './shell.css';
import { activateWorkspace, activeWorkspace, initialWorkspace, listWorkspaces, LOCAL_SERVER_ORIGIN, rememberWorkspace, selectWorkspace, serverOrigin, type RemoteWorkspace } from './workspace-registry';
import { nativeBridge, openEmbeddedWorkspace, useEmbeddedServer } from './native-runtime';
import { guardNativeClose } from './native-close';
import { nativeSessionAdapter } from './native-session';
import { applyAppearance, readAppearance } from './settings';
import { CloudClient, mountCloudGateway } from './cloud';
import { mountServerPicker } from './cloud/server-picker';
import { brandedTitle } from './tab-identity';

import {loadReactGrab, onReactGrabShortcut, reactGrabAvailable} from './react-grab';

if (reactGrabAvailable) {
  window.addEventListener('keydown', onReactGrabShortcut, {capture: true});
  void loadReactGrab().catch(() => { /* Settings lets the user retry loading. */ });
}

const root = document.querySelector('#app');
const native = '__TAURI_INTERNALS__' in window;

function manageSectionFromParams(params: URLSearchParams): 'invites' | 'members' | undefined {
  if (!params.get('manage')) return undefined;
  return params.get('section') === 'invites' ? 'invites' : 'members';
}

function settingsOpenDetail(section: string): 'invites' | 'members' | 'general' {
  if (section === 'invites') return 'invites';
  if (section === 'members') return 'members';
  return 'general';
}

function startupErrorNode(host: HTMLElement): HTMLElement {
  const existing = host.querySelector<HTMLElement>('[data-startup-error]');
  if (existing) return existing;
  const message = document.createElement('p');
  message.setAttribute('data-startup-error', '');
  message.setAttribute('role', 'alert');
  host.append(message);
  return message;
}

async function boot(root: HTMLElement): Promise<void> {
  applyAppearance(root, readAppearance());
  const params = new URLSearchParams(location.search);
  const browserPage = !native && params.get('web') === '1' ? parsePageLink(location.href) : undefined;
  let selected = activeWorkspace();
  const explicitGateway = params.get('cloud') === '1';
  function chooseServer(server: string): void {
    const url = new URL(location.href);
    url.searchParams.delete('local');
    url.searchParams.delete('page');
    if (selected.kind === 'remote' && selected.embedded && selected.server === server) {
      url.searchParams.delete('server');
      url.searchParams.delete('cloud');
      url.searchParams.set('embedded', '1');
    } else {
      url.searchParams.delete('embedded');
      url.searchParams.set('server', serverOrigin(server));
      url.searchParams.set('cloud', '1');
    }
    location.assign(url.href);
  }
  if (native && explicitGateway && !params.has('server') && !params.has('embedded') &&
      (selected.kind === 'local' || selected.embedded)) {
    mountServerPicker(root, chooseServer, () => {
      const url = new URL(location.href);
      url.searchParams.delete('cloud');
      location.assign(url.href);
    });
    return;
  }
  const embedded = native && await useEmbeddedServer(params, selected);
  let configured = native
    ? params.get('server') ?? (selected.kind === 'remote' ? selected.server : import.meta.env.VITE_BLOK_SERVER_URL)
    : location.origin;
  let desktop: typeof import('./shell') | undefined;
  if (embedded) {
    try {
      // Load the editor while the native services start. Mount it only after selecting the workspace.
      const [opened, shell] = await Promise.all([
        openEmbeddedWorkspace(selected, params.get('embedded') === '1'),
        import('./shell'),
      ]);
      desktop = shell;
      const url = new URL(location.href);
      if (selected.kind === 'local' && selected.id === 'default' && opened.activePageId &&
          !url.searchParams.has('page') && !url.searchParams.has('view')) {
        url.searchParams.set('page', opened.activePageId);
      }
      for (const key of ['cloud', 'embedded', 'local']) url.searchParams.delete(key);
      if (url.href !== location.href) history.replaceState(null, '', url.href);
      for (const other of opened.otherWorkspaces ?? []) rememberWorkspace(other);
      selected = opened.workspace;
      activateWorkspace(selected);
      configured = selected.server;
    } catch (reason) {
      showStartupFailure(root, reason, () => selectWorkspace(initialWorkspace));
      return;
    }
  }
  const origin = configured ? serverOrigin(configured) : '';
  const adapter = native && origin ? nativeSessionAdapter(origin) : undefined;
  const client = new CloudClient({origin, sessionAdapter: adapter});
  const manageSlug = params.get('manage');
  const manageSection = manageSectionFromParams(params);

  const showGateway = async (): Promise<void> => {
    document.title = brandedTitle('Connexion');
    await mountCloudGateway(root, {
      apiOrigin: origin || undefined,
      sessionAdapter: adapter,
      allowLocal: native,
      initialManage: manageSlug && manageSection ? {slug: manageSlug, section: manageSection} : undefined,
      initialWorkspaceId: browserPage?.workspace,
      onOpenWorkspace: async (workspace, source) => {
        const session = source.currentSession ?? await source.session();
        const ref: RemoteWorkspace = {
          kind: 'remote', id: workspace.id, name: workspace.name,
          server: serverOrigin(source.origin || location.origin), accountId: session.user.id,
          workspaceId: workspace.slug, userName: session.user.email, role: workspace.role,
        };
        // ?manage= opens the workspace then the settings modal (admin screen removed).
        if (manageSlug && manageSection && workspace.slug === manageSlug) {
          sessionStorage.setItem('blok:desktop:pending-settings', manageSection);
        }
        selectWorkspace(ref, browserPage?.origin === ref.server && (!browserPage.workspace || browserPage.workspace === ref.id) ? browserPage.id : undefined);
      },
      onOpenLocal: () => selectWorkspace(selected.kind === 'local' || selected.device ? selected : listWorkspaces().find(ref => ref.kind === 'remote' && ref.device) ?? initialWorkspace),
      onServerChange: (server) => {
        if (!native) {
          location.assign(serverOrigin(server));
          return;
        }
        chooseServer(server);
      },
    });
  };

  if ((!embedded && explicitGateway) || (!native && selected.kind === 'local' && params.get('local') !== '1') ||
      (browserPage?.workspace && browserPage.workspace !== selected.id)) {
    await showGateway();
    return;
  }
  if (!embedded && selected.kind === 'remote' && !(await refreshRemoteMembership(client, selected, origin, showGateway))) {
    return;
  }
  const {mountDesktop, flushDesktop} = desktop ?? await import('./shell');
  root.addEventListener('blok:desktop-connect-cloud', (event) => {
    const section = (event as CustomEvent<{section?: string}>).detail?.section;
    // Already inside a remote workspace: open settings in place instead of the old gateway admin screen.
    if (selected.kind === 'remote' && (section === 'settings' || section === 'invites' || section === 'members')) {
      const footer = root.querySelector('[data-desktop-footer]');
      footer?.dispatchEvent(new CustomEvent('blok:desktop-open-settings', {
        detail: settingsOpenDetail(section),
      }));
      return;
    }
    void flushDesktop().then(() => {
      const url = new URL(location.href);
      url.searchParams.set('cloud', '1');
      if (native && section === 'local-server') {
        url.searchParams.delete('embedded');
        url.searchParams.set('server', LOCAL_SERVER_ORIGIN);
      }
      if (native && section === 'embedded-server') {
        url.searchParams.delete('server');
        url.searchParams.delete('local');
        url.searchParams.set('embedded', '1');
      }
      url.searchParams.delete('page');
      url.searchParams.delete('manage');
      url.searchParams.delete('section');
      location.assign(url.href);
    }).catch(showError);
  });
  const bridge = nativeBridge();
  if (bridge) await guardNativeClose(root, bridge, flushDesktop);
  mountDesktop(root);
}

async function refreshRemoteMembership(
  client: CloudClient,
  selected: Extract<ReturnType<typeof activeWorkspace>, { kind: 'remote' }>,
  origin: string,
  showGateway: () => Promise<void>,
): Promise<boolean> {
  try {
    const session = await client.session();
    const membership = session.workspaces.find(item => item.slug === selected.workspaceId);
    if (session.user.id !== selected.accountId || !membership || selected.server !== origin) {
      await showGateway();
      return false;
    }
    rememberWorkspace({...selected, role: membership.role, name: membership.name});
    return true;
  } catch {
    await showGateway();
    return false;
  }
}

function showStartupFailure(host: HTMLElement, reason: unknown, openDisk?: () => void): void {
  const panel = host.querySelector<HTMLElement>('[data-blok-startup]');
  const status = panel?.querySelector<HTMLElement>('.startup-status');
  if (!panel || !status) {
    startupErrorNode(host).textContent = reason instanceof Error ? reason.message : 'Impossible d’ouvrir cet espace.';
    return;
  }
  panel.setAttribute('aria-busy', 'false');
  status.setAttribute('role', 'alert');
  status.textContent = reason instanceof Error ? reason.message : 'Impossible d’ouvrir cet espace.';
  const actions = document.createElement('div');
  actions.className = 'startup-actions';
  const retry = document.createElement('button');
  retry.textContent = 'Réessayer';
  retry.onclick = () => location.reload();
  actions.append(retry);
  if (openDisk) {
    const offline = document.createElement('button');
    offline.textContent = 'Ouvrir un espace sur disque';
    offline.onclick = openDisk;
    actions.append(offline);
  }
  status.after(actions);
}

function showError(error: unknown): void {
  if (!(root instanceof HTMLElement)) return;
  if (root.querySelector('[data-blok-startup]')) { showStartupFailure(root, error); return; }
  const message = startupErrorNode(root);
  message.textContent = error instanceof Error ? error.message : 'Impossible d’ouvrir cet espace. Rechargez pour réessayer.';
}
if (root instanceof HTMLElement) void listenForPageLinks(showError).then(() => boot(root)).catch(showError);
