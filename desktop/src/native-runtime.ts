import { CloudApiError, CloudClient, type CloudSession } from './cloud/client';
import { bindDeviceSession, nativeSessionAdapter } from './native-session';
import { prefersDefaultDisk, type RemoteWorkspace, type WorkspaceRef } from './workspace-registry';

type NativeBridge = { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
export function nativeBridge(): NativeBridge | undefined {
  return (window as Window & {__TAURI_INTERNALS__?: NativeBridge}).__TAURI_INTERNALS__;
}

export async function embeddedServerAvailable(): Promise<boolean> {
  try { return await nativeBridge()?.invoke('embedded_server_available') === true; }
  catch { return false; }
}

export async function useEmbeddedServer(params: URLSearchParams, workspace: WorkspaceRef): Promise<boolean> {
  const native = nativeBridge();
  if (!native || params.has('server')) return false;
  if (params.get('embedded') === '1') return true;
  if (workspace.kind === 'remote') return workspace.embedded === true;
  return params.get('local') !== '1' && workspace.id === 'default' && !prefersDefaultDisk() && await embeddedServerAvailable();
}

function localOrigin(origin: unknown): string {
  if (typeof origin !== 'string') throw new Error('Le serveur intégré ne répond pas.');
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== origin) {
    throw new Error('Adresse du serveur intégré invalide.');
  }
  return origin;
}

export async function startEmbeddedServer(): Promise<string> {
  return localOrigin(await nativeBridge()?.invoke('ensure_embedded_server'));
}

interface DeviceSession extends CloudSession { origin: string; token: string; deviceWorkspaceId: string; deviceActivePageId?: string | null; deviceImportedWorkspaceId?: string | null }

export async function openEmbeddedWorkspace(selected: WorkspaceRef, explicit: boolean): Promise<{workspace: RemoteWorkspace; activePageId?: string; otherWorkspaces?: RemoteWorkspace[]}> {
  const previous = selected.kind === 'remote' && selected.embedded ? selected : undefined;
  if (previous && !previous.device && !explicit) {
    // A pre-device build could already have a signed-in, password-based workspace.
    const origin = await startEmbeddedServer();
    if (origin !== previous.server) throw new Error('L’adresse du serveur intégré de cet espace a changé.');
    const adapter = nativeSessionAdapter(origin);
    if (await adapter.getToken()) {
      try {
        const session = await new CloudClient({origin, sessionAdapter: adapter}).session();
        const membership = session.workspaces.find(w => w.slug === previous.workspaceId);
        if (session.user.id === previous.accountId && membership) return {workspace:{...previous, name: membership.name, role: membership.role, userName:session.user.name || 'Profil local'}};
      } catch (error) { if (!(error instanceof CloudApiError && error.status === 401)) throw error; }
    }
  }
  const {result, origin, references} = await deviceWorkspaces();
  if (previous?.device && !explicit && origin !== previous.server) throw new Error('L’adresse du serveur intégré de cet espace a changé.');
  const imported = selected.kind === 'local' && selected.id === 'default' ? result.deviceImportedWorkspaceId : undefined;
  const preferred = previous?.device && previous.accountId === result.user.id ? previous.id : imported || result.deviceWorkspaceId;
  const workspace = references.find(w => w.id === preferred) ?? references.find(w => w.id === result.deviceWorkspaceId);
  if (!workspace) throw new Error('Espace de cet appareil introuvable.');
  bindDeviceSession(origin, result.token);
  const importedHere = !result.deviceImportedWorkspaceId || workspace.id === result.deviceImportedWorkspaceId;
  return {
    workspace,
    otherWorkspaces: references.filter(w => w.id !== workspace.id),
    activePageId: importedHere && typeof result.deviceActivePageId === 'string' ? result.deviceActivePageId : undefined,
  };
}

export async function deviceWorkspaces() {
  const result = await nativeBridge()?.invoke('embedded_device_session') as DeviceSession | undefined;
  const origin = localOrigin(result?.origin);
  if (typeof result?.token !== 'string' || !result.token || !result.user?.id || !Array.isArray(result.workspaces)) throw new Error('Profil local indisponible.');
  const references: RemoteWorkspace[] = result.workspaces.map(w => ({
    kind:'remote', embedded:true, device:true, id:w.id, name:w.name, server:origin,
    workspaceId:w.slug, role:w.role, accountId:result.user.id, userName:result.user.name || 'Profil local',
  }));
  return {result, origin, references};
}
