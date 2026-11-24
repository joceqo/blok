import type { WorkspaceRef } from './workspace-registry';
import { hasSelectedWorkspace } from './workspace-registry';

type NativeBridge = { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
function bridge(): NativeBridge | undefined {
  return (window as Window & {__TAURI_INTERNALS__?: NativeBridge}).__TAURI_INTERNALS__;
}

export async function embeddedServerAvailable(): Promise<boolean> {
  try { return await bridge()?.invoke('embedded_server_available') === true; }
  catch { return false; }
}

export async function useEmbeddedServer(params: URLSearchParams, workspace: WorkspaceRef, configuredServer?: string): Promise<boolean> {
  const native = bridge();
  if (!native || params.has('server')) return false;
  if (params.get('embedded') === '1') return true;
  if (workspace.kind === 'remote') return workspace.embedded === true;
  if (params.get('local') === '1' || workspace.id !== 'default' || configuredServer || hasSelectedWorkspace() || !await embeddedServerAvailable()) return false;
  // A previous version could save local pages before the user ever selected a
  // workspace. Preserve that library when upgrading an existing installation.
  return await native.invoke('load_workspace_file', {name: 'index'}) === null;
}

export async function startEmbeddedServer(): Promise<string> {
  const origin = await bridge()?.invoke('ensure_embedded_server');
  if (typeof origin !== 'string') throw new Error('Le serveur intégré ne répond pas.');
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== origin) {
    throw new Error('Adresse du serveur intégré invalide.');
  }
  return origin;
}
