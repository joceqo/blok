import type { OutputData } from '../../types';
import { extractPageOutline } from './page-outline';
import { mergeWorkspaceIndex } from './workspace-merge';
import { StaleFileError, loadIndex, readFile, readFileContents, writeFile, type WorkspaceIndex } from './storage';
import { nativeSessionAdapter } from './native-session';
import type { WorkspaceRef } from './workspace-registry';
class RepositoryHttpError extends Error { constructor(public status: number, public requestId?: string | null) { super(`Serveur indisponible (${status})`); } }
/**
 * The server already holds a document for this page.
 *
 * Not a failure: `seed` fills a page exactly once, so this is the server
 * answering that the workspace was initialized before — by someone else, or by
 * this account on another device.
 */
export class DocumentAlreadyInitializedError extends Error {
  public constructor(public readonly pageId: string) {
    super(`Le document « ${pageId} » existe déjà sur le serveur.`);
    this.name = 'DocumentAlreadyInitializedError';
  }
}
const snapshot = (index: WorkspaceIndex): WorkspaceIndex => JSON.parse(JSON.stringify(index)) as WorkspaceIndex;
/** A repository owns one immutable identity, including all queued writes. */
export function workspaceRepository(workspace: WorkspaceRef) {
  const ref = Object.freeze({...workspace});
  let revision: number | null = null;
  let baseline: WorkspaceIndex | null = null;
  let acknowledged: WorkspaceIndex | null = null;
  const pageWrites = new Map<string, Promise<void>>();
  const base = ref.kind === 'remote' ? `${ref.server}/api/workspaces/${encodeURIComponent(ref.workspaceId)}` : '';
  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const token = ref.kind === 'remote' && '__TAURI_INTERNALS__' in window ? await nativeSessionAdapter(ref.server).getToken() : null;
    const response = await fetch(url, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers } });
    if (!response.ok) throw new RepositoryHttpError(response.status, response.headers?.get('X-Request-ID'));
    return await response.json() as T;
  }
  return {
    ref,
    async loadIndex(): Promise<WorkspaceIndex> {
      if (ref.kind === 'local') {
        const index = await loadIndex(ref);
        baseline = snapshot(index); acknowledged = snapshot(index);
        return index;
      }
      const value = await request<WorkspaceIndex & { revision: number }>(`${base}/index`);
      revision = value.revision;
      const index = { pages: value.pages, trash: value.trash ?? [], activeId: value.pages[0]?.id ?? '', access: value.access };
      baseline = snapshot(index); acknowledged = snapshot(index);
      return index;
    },
    async refreshIndex(accept: () => boolean): Promise<WorkspaceIndex | null> {
      if (ref.kind !== 'remote') return null;
      const value = await request<WorkspaceIndex & {revision: number}>(`${base}/index`);
      if (!accept()) return null;
      revision = value.revision;
      const index = {pages:value.pages,trash:value.trash ?? [],activeId:value.pages[0]?.id ?? '',access:value.access};
      baseline = snapshot(index); acknowledged = snapshot(index);
      return index;
    },
    async saveIndex(value: WorkspaceIndex): Promise<WorkspaceIndex> {
      if (ref.kind === 'local') {
        const intent = snapshot(value);
        // The index belongs to everything that touches this workspace at once: a
        // second window, an agent over MCP, a sync tool. Refusing the write would
        // strand this window on a fingerprint it can never satisfy again, so a
        // refusal re-reads what the other writer left and replays our own changes
        // on top of it — the same three-way merge the server path performs.
        if (!baseline || !acknowledged) {
          await writeFile('index', JSON.stringify(intent), ref);
          baseline = intent; acknowledged = snapshot(intent);
          return intent;
        }
        let merged = mergeWorkspaceIndex(baseline, intent, acknowledged);
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await writeFile('index', JSON.stringify(merged), ref);
            baseline = intent; acknowledged = snapshot(merged);
            return merged;
          } catch (error) {
            if (!(error instanceof StaleFileError) || attempt === 3) throw error;
            acknowledged = snapshot(await loadIndex(ref));
            merged = mergeWorkspaceIndex(baseline, intent, acknowledged);
          }
        }
        throw new Error('L’espace change trop rapidement. Réessayez.');
      }
      if (revision === null || !baseline || !acknowledged) throw new Error('L’espace doit être chargé avant son enregistrement');
      const intent = snapshot(value);
      let merged = mergeWorkspaceIndex(baseline, intent, acknowledged);
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const next = await request<{ revision: number }>(`${base}/index`, { method: 'PUT', body: JSON.stringify({ pages: merged.pages, trash: merged.trash ?? [], revision }) });
          revision = next.revision;
          baseline = intent; acknowledged = snapshot(merged);
          return merged;
        } catch (error) {
          if (!(error instanceof RepositoryHttpError) || error.status !== 409 || attempt === 3) throw error;
          const fresh = await request<WorkspaceIndex & {revision: number}>(`${base}/index`);
          revision = fresh.revision;
          acknowledged = {pages:fresh.pages,trash:fresh.trash ?? [],activeId:fresh.pages[0]?.id ?? ''};
          merged = mergeWorkspaceIndex(baseline, intent, acknowledged);
        }
      }
      throw new Error('L’espace change trop rapidement. Réessayez.');
    },
    /** Lazy read-only discovery; remote editing still exclusively uses collaboration. */
    async readPageOutline(id: string) {
      if (ref.kind === 'remote') return extractPageOutline(id, await request<unknown>(`${base}/pages/${encodeURIComponent(id)}`));
      await (pageWrites.get(id) ?? Promise.resolve());
      const raw = await readFileContents(id, ref);
      return extractPageOutline(id, raw === null ? null : JSON.parse(raw) as unknown);
    },
    readPage(id: string) {
      if (ref.kind !== 'local') throw new Error('Remote documents require collaboration');
      return (pageWrites.get(id) ?? Promise.resolve()).then(() => readFile(id, ref));
    },
    writePage(id: string, data: string) {
      if (ref.kind !== 'local') throw new Error('Remote documents require collaboration');
      const pending = (pageWrites.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => writeFile(id, data, ref));
      pageWrites.set(id, pending);
      // Keep only in-flight work. The next retry must reach the native guard again.
      return pending.finally(() => {
        if (pageWrites.get(id) === pending) pageWrites.delete(id);
      });
    },
    async readLivePage(id: string): Promise<OutputData> {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      const {ticket} = await request<{ticket: string}>(`${base}/ticket?doc=${encodeURIComponent(id)}`);
      return request<OutputData>(`${ref.server}/api/blok/sync/${encodeURIComponent(id)}/state`, {headers: {Authorization: `Bearer ${ticket}`}});
    },
    async seedPage(id: string, document: unknown): Promise<void> {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      try {
        await request(`${base}/pages/${encodeURIComponent(id)}/seed`, {method: 'POST', body: JSON.stringify({document})});
      } catch (error) {
        if (error instanceof RepositoryHttpError && error.status === 409) throw new DocumentAlreadyInitializedError(id);
        throw error;
      }
    },
    async duplicatePage(source: string, page: {id: string; title: string; parentId: string | null}): Promise<void> {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      await request(`${base}/pages/${encodeURIComponent(source)}/duplicate`, {method: 'POST', body: JSON.stringify(page)});
    },
    async changePageTrash(id: string, action: 'trash' | 'restore' | 'purge'): Promise<void> {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      const suffix = action === 'trash' ? '' : '/' + action;
      await request(`${base}/pages/${encodeURIComponent(id)}${suffix}`, {method: action === 'restore' ? 'POST' : 'DELETE'});
    },
    async clearLocalPage(id: string): Promise<void> {
      if (ref.kind !== 'local') throw new Error('Local operation only');
      await pageWrites.get(id);
      await readFile(id, ref);
      // The native store checks the last-read fingerprint before replacing the payload.
      await writeFile(id, '', ref);
    },
    async movePage(id: string, parentId: string | null, teamspaceId?: string | null): Promise<void> {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      try {
        await request(`${base}/pages/${encodeURIComponent(id)}/move`, {method: 'POST', body: JSON.stringify({parentId, teamspaceId})});
      } catch (error) {
        if (error instanceof RepositoryHttpError) {
          if (error.status === 403 || error.status === 404) throw new Error('Vous n’avez plus les droits nécessaires pour déplacer cette page ou l’une de ses sous-pages.', { cause: error });
          if (error.status === 409) throw new Error('La page ou sa destination a changé. Actualisez puis réessayez.', { cause: error });
          if (error.status === 400) throw new Error('Cette destination ne peut pas contenir la page.', { cause: error });
        }
        throw error;
      }
    },
    async uploadImage(dataUrl: string): Promise<string> {
      if (ref.kind === 'local') return dataUrl;
      const image = await request<{url: string}>(`${base}/images`, {method: 'POST', body: JSON.stringify({dataUrl})});
      return new URL(image.url, ref.server).href;
    },
    async assetUrl(url: string): Promise<string> {
      if (ref.kind !== 'remote') return url;
      const asset = new URL(url, ref.server);
      if (asset.origin !== ref.server || !asset.pathname.startsWith('/files/')) return url;
      return (await request<{url: string}>(`${ref.server}/api/assets/url?url=${encodeURIComponent(asset.href)}`)).url;
    },
    async ticket(doc: string): Promise<string> { return (await request<{ticket: string}>(`${base}/ticket?doc=${encodeURIComponent(doc)}`)).ticket; },
  };
}
