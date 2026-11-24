import './editor.css';
import '../../src/shell/sidebar.css';
import './shell.css';
import { activeWorkspace, initialWorkspace, LOCAL_SERVER_ORIGIN, rememberWorkspace, selectWorkspace, serverOrigin, type RemoteWorkspace } from './workspace-registry';
import { startEmbeddedServer, useEmbeddedServer } from './native-runtime';
import { nativeSessionAdapter } from './native-session';
import { applyAppearance, readAppearance } from './settings';
import { CloudClient, mountCloudGateway } from './cloud';
import { brandedTitle } from './tab-identity';

import {loadReactGrab, reactGrabAvailable} from './react-grab';

if (reactGrabAvailable) void loadReactGrab().catch(() => { /* Settings lets the user retry loading. */ });

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
  const selected = activeWorkspace();
  const explicitGateway = params.get('cloud') === '1';
  const embedded = native && await useEmbeddedServer(params, selected, import.meta.env.VITE_BLOK_SERVER_URL);
  let configured = native
    ? params.get('server') ?? (selected.kind === 'remote' ? selected.server : import.meta.env.VITE_BLOK_SERVER_URL)
    : location.origin;
  if (embedded) {
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Ouverture de votre espace sur cet ordinateur…';
    root.replaceChildren(status);
    try {
      configured = await startEmbeddedServer();
      if (selected.kind === 'remote' && selected.embedded && selected.server !== configured) {
        throw new Error('L’adresse de cet espace a changé. Vérifiez le répertoire de données du serveur intégré.');
      }
    } catch (reason) {
      const retry = document.createElement('button');
      retry.textContent = 'Réessayer'; retry.onclick = () => location.reload();
      const offline = document.createElement('button');
      offline.textContent = 'Ouvrir un espace sur disque'; offline.onclick = () => selectWorkspace(initialWorkspace);
      status.textContent = reason instanceof Error ? reason.message : String(reason);
      root.append(retry, offline);
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
      onOpenWorkspace: async (workspace, source) => {
        const session = source.currentSession ?? await source.session();
        const ref: RemoteWorkspace = {
          kind: 'remote', ...(embedded ? {embedded: true} : {}), id: workspace.id, name: workspace.name,
          server: serverOrigin(source.origin || location.origin), accountId: session.user.id,
          workspaceId: workspace.slug, userName: session.user.email, role: workspace.role,
        };
        // ?manage= opens the workspace then the settings modal (admin screen removed).
        if (manageSlug && manageSection && workspace.slug === manageSlug) {
          sessionStorage.setItem('blok:desktop:pending-settings', manageSection);
        }
        selectWorkspace(ref);
      },
      onOpenLocal: () => selectWorkspace(selected.kind === 'local' ? selected : initialWorkspace),
      onServerChange: (server) => {
        if (!native) {
          location.assign(serverOrigin(server));
          return;
        }
        const url = new URL(location.href);
        url.searchParams.delete('embedded');
        url.searchParams.set('server', serverOrigin(server));
        url.searchParams.set('cloud', '1');
        url.searchParams.delete('page');
        location.assign(url.href);
      },
    });
  };

  if (explicitGateway || (embedded && selected.kind === 'local') || (!native && selected.kind === 'local' && params.get('local') !== '1')) {
    await showGateway();
    return;
  }
  if (selected.kind === 'remote' && !(await refreshRemoteMembership(client, selected, origin, showGateway))) {
    return;
  }
  const {mountDesktop, flushDesktop} = await import('./shell');
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

function showError(error: unknown): void {
  if (!(root instanceof HTMLElement)) return;
  const message = startupErrorNode(root);
  message.textContent = error instanceof Error ? error.message : 'Impossible d’ouvrir cet espace. Rechargez pour réessayer.';
}
if (root instanceof HTMLElement) void boot(root).catch(showError);
