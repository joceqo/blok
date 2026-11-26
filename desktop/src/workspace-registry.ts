<<<<<<< HEAD
import { clearPageRoute, pageUrlForView, type PageView } from './page-link';
/** Non-secret workspace references. Session credentials live in the OS keychain. */
export type LocalWorkspace = { kind: 'local'; id: string; name: string };
export type RemoteWorkspace = { kind: 'remote'; embedded?: boolean; device?: boolean; importedDefaultDisk?: boolean; id: string; name: string; server: string; accountId: string; workspaceId: string; userName?: string; role?: 'admin' | 'member' | 'viewer' };
export type WorkspaceRef = LocalWorkspace | RemoteWorkspace;
const KEY = 'blok:desktop:workspaces:v1';
const ACTIVE = 'blok:desktop:active-workspace:v1';
const DISK = 'blok:desktop:prefer-default-disk:v1';
export function prefersDefaultDisk(): boolean { return localStorage.getItem(DISK) === '1'; }
export const LOCAL_SERVER_ORIGIN = 'http://localhost:18150';
export const initialWorkspace: LocalWorkspace = { kind: 'local', id: 'default', name: 'Espace local' };
export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Le serveur doit utiliser HTTPS');
  if (url.username || url.password) throw new Error('Adresse du serveur invalide');
  return url.origin;
}
export function workspaceKey(ref: WorkspaceRef): string {
  return ref.kind === 'local' ? `local:${ref.id}` : JSON.stringify(['remote', serverOrigin(ref.server), ref.accountId, ref.workspaceId]);
}
export function listWorkspaces(): WorkspaceRef[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(data)) return [initialWorkspace];
    const refs = data.filter((item): item is WorkspaceRef => {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return false;
      if (item.kind === 'local') return /^[a-zA-Z0-9-]+$/.test(item.id);
      try { return item.kind === 'remote' && typeof item.accountId === 'string' && typeof item.workspaceId === 'string' && serverOrigin(item.server) === item.server; } catch { return false; }
    });
    const saved = refs.filter(item => workspaceKey(item) !== workspaceKey(initialWorkspace));
    const imported = saved.some(item => item.kind === 'remote' && item.device && item.embedded && item.importedDefaultDisk);
    return imported && !prefersDefaultDisk() ? saved : [initialWorkspace, ...saved];
  } catch { return [initialWorkspace]; }
}
export function activeWorkspace(): WorkspaceRef {
  return listWorkspaces().find((item) => workspaceKey(item) === localStorage.getItem(ACTIVE)) ?? initialWorkspace;
}
export function rememberWorkspace(ref: WorkspaceRef): void {
  const all = listWorkspaces().filter((item) => workspaceKey(item) !== workspaceKey(ref));
  localStorage.setItem(KEY, JSON.stringify([...all, ref]));
}
export function forgetWebAccount(account: RemoteWorkspace): void {
  const removed = (item: WorkspaceRef) => item.kind === 'remote' && !item.embedded && !item.device &&
    item.server === account.server && item.accountId === account.accountId;
  const all = listWorkspaces();
  const active = localStorage.getItem(ACTIVE);
  if (all.some(item => removed(item) && workspaceKey(item) === active)) localStorage.removeItem(ACTIVE);
  localStorage.setItem(KEY, JSON.stringify(all.filter(item => !removed(item))));
}

export function createLocalWorkspace(name: string): LocalWorkspace {
  const ref: LocalWorkspace = { kind: 'local', id: crypto.randomUUID(), name: name.trim().slice(0, 80) || 'Nouvel espace local' };
  rememberWorkspace(ref);
  return ref;
}
export function activateWorkspace(ref: WorkspaceRef): void {
  rememberWorkspace(ref);
  localStorage.setItem(ACTIVE, workspaceKey(ref));
  if (ref.kind === 'remote' && ref.device) localStorage.removeItem(DISK);
}

function workspaceRoute(ref: WorkspaceRef, pageId?: string, view?: PageView): URL {
  if (ref.kind === 'local' && ref.id === 'default') localStorage.setItem(DISK, '1');
  activateWorkspace(ref);
  const current = new URL(location.href);
  const url = pageId ? pageUrlForView(current, pageId, view) : current;
  if (!pageId) clearPageRoute(url);
  // Keep an explicitly scoped web link shareable after the first workspace selection.
  if (pageId && ref.kind === 'local') url.searchParams.set('workspace', ref.id);
  else if (!pageId || url.searchParams.get('workspace') !== ref.id) url.searchParams.delete('workspace');
  url.searchParams.delete('cloud');
  url.searchParams.delete('manage');
  url.searchParams.delete('section');
  url.searchParams.delete('server');
  url.searchParams.delete('embedded');
  if (ref.kind === 'local') url.searchParams.set('local', '1');
  else url.searchParams.delete('local');
  return url;
}

/** Call only after the current editor has flushed; reload removes all old listeners and timers. */
export function selectWorkspace(ref: WorkspaceRef, pageId?: string, view?: PageView): void {
  location.assign(workspaceRoute(ref, pageId, view).href);
}

/** An OS launch URL was validated before any editor or saved account was opened. */
export function selectStartupPage(ref: WorkspaceRef, pageId: string, view?: PageView): void {
  history.replaceState(history.state, '', workspaceRoute(ref, pageId, view).href);
}
||||||| f8ef3c6b39
=======
/** Non-secret workspace references. Session credentials live in the OS keychain. */
export type LocalWorkspace = { kind: 'local'; id: string; name: string };
export type RemoteWorkspace = { kind: 'remote'; id: string; name: string; server: string; accountId: string; workspaceId: string; userName?: string; role?: 'admin' | 'member' | 'viewer' };
export type WorkspaceRef = LocalWorkspace | RemoteWorkspace;
const KEY = 'blok:desktop:workspaces:v1';
const ACTIVE = 'blok:desktop:active-workspace:v1';
export const initialWorkspace: LocalWorkspace = { kind: 'local', id: 'default', name: 'Espace local' };
export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Le serveur doit utiliser HTTPS');
  if (url.username || url.password) throw new Error('Adresse du serveur invalide');
  return url.origin;
}
export function workspaceKey(ref: WorkspaceRef): string {
  return ref.kind === 'local' ? `local:${ref.id}` : JSON.stringify(['remote', serverOrigin(ref.server), ref.accountId, ref.workspaceId]);
}
export function listWorkspaces(): WorkspaceRef[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(data)) return [initialWorkspace];
    const refs = data.filter((item): item is WorkspaceRef => {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return false;
      if (item.kind === 'local') return /^[a-zA-Z0-9-]+$/.test(item.id);
      try { return item.kind === 'remote' && typeof item.accountId === 'string' && typeof item.workspaceId === 'string' && serverOrigin(item.server) === item.server; } catch { return false; }
    });
    return [initialWorkspace, ...refs.filter((item) => workspaceKey(item) !== workspaceKey(initialWorkspace))];
  } catch { return [initialWorkspace]; }
}
export function activeWorkspace(): WorkspaceRef {
  return listWorkspaces().find((item) => workspaceKey(item) === localStorage.getItem(ACTIVE)) ?? initialWorkspace;
}
export function rememberWorkspace(ref: WorkspaceRef): void {
  const all = listWorkspaces().filter((item) => workspaceKey(item) !== workspaceKey(ref));
  localStorage.setItem(KEY, JSON.stringify([...all, ref]));
}
export function createLocalWorkspace(name: string): LocalWorkspace {
  const ref: LocalWorkspace = { kind: 'local', id: crypto.randomUUID(), name: name.trim().slice(0, 80) || 'Nouvel espace local' };
  rememberWorkspace(ref);
  return ref;
}
/** Call only after the current editor has flushed; reload removes all old listeners and timers. */
export function selectWorkspace(ref: WorkspaceRef): void {
  rememberWorkspace(ref);
  localStorage.setItem(ACTIVE, workspaceKey(ref));
  const url = new URL(location.href);
  url.searchParams.delete('page');
  url.searchParams.delete('cloud');
  url.searchParams.delete('manage');
  url.searchParams.delete('section');
  url.searchParams.delete('server');
  if (ref.kind === 'local') url.searchParams.set('local', '1');
  else url.searchParams.delete('local');
  location.assign(url.href);
}
>>>>>>> origin/fix/self-host-review
