<<<<<<< HEAD
import { pageAccess } from './page-access';
import { moveDestinations, PageMoveConflict } from './page-move';
import { mergeWorkspaceIndex } from './workspace-merge';
import { loadIndex, peekFile, readFile, saveIndex, writeFile, type WorkspaceIndex } from './storage';
import { nativeSessionAdapter } from './native-session';
import type { WorkspaceRef } from './workspace-registry';
export class RepositoryHttpError extends Error { constructor(public status: number) { super(`Serveur indisponible (${status})`); } }
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
    if (!response.ok) throw new RepositoryHttpError(response.status);
    return await response.json() as T;
  }
  async function searchSources(query: string, signal: AbortSignal, palette = false) {
    return (await request<{sources: {id: string; title: string; excerpt: string}[]}>(`${base}/search`, {
      method: 'POST', body: JSON.stringify(palette ? {query, mode:'palette'} : {query}), signal,
    })).sources;
  }
  return {
    ref,
    searchSources,
    async listPeople() {
      if (ref.kind !== 'remote') return [];
      const result = await request<{members: {id: string; name: string; email: string}[]}>(base + '/members');
      return result.members.map(({id, name, email}) => ({id, name: name.trim() || email || 'Profil local'}));
    },
    // One cache per open palette, scoped to this local workspace. A new search
    // session sees subsequent disk edits. Remote previews always require a fresh ACL check.
    pageSearch(pages: () => WorkspaceIndex['pages']) {
      const texts = new Map<string, string>();
      async function diskText(id: string, signal: AbortSignal): Promise<string> {
        signal.throwIfAborted();
        const cached = texts.get(id);
        if (cached !== undefined) return cached;
        const [raw, {blocksToPlainText}] = await Promise.all([peekFile(id, ref), import('@bloklabs/core/view')]);
        signal.throwIfAborted();
        const text = raw ? blocksToPlainText(JSON.parse(raw)) : '';
        texts.set(id, text);
        return text;
      }
      return {
        async preview(id: string, signal: AbortSignal): Promise<string> {
          if (!pages().some(page => page.id === id)) return '';
          if (ref.kind === 'local') return (await diskText(id, signal)).slice(0,1600);
          // Older remote servers return the authorized document for this same URL.
          type Document = NonNullable<Parameters<typeof import('@bloklabs/core/view').blocksToPlainText>[0]>;
          const result = await request<{excerpt: string} | Document | null>(`${base}/pages/${encodeURIComponent(id)}?preview=1`, {signal});
          if (!result) return '';
          if ('excerpt' in result && typeof result.excerpt === 'string') return result.excerpt;
          const {blocksToPlainText} = await import('@bloklabs/core/view');
          return 'blocks' in result ? blocksToPlainText(result).slice(0,1600) : '';
        },
        async searchContent(query: string, signal: AbortSignal) {
          if (ref.kind === 'remote') return searchSources(query, signal, true);
          const needle = query.trim().toLocaleLowerCase();
          const matches: {id:string; excerpt:string}[] = [];
          if (!needle) return matches;
          for (const {id} of pages()) {
            const text = await diskText(id, signal);
            const hit = text.toLocaleLowerCase().indexOf(needle);
            if (hit >= 0) matches.push({id, excerpt:text.slice(Math.max(0,hit-75),hit+needle.length+175)});
            if (matches.length === 40) break;
          }
          return matches;
        },
      };
    },
    async loadIndex(): Promise<WorkspaceIndex> {
      if (ref.kind === 'local') return loadIndex(ref);
      const value = await request<WorkspaceIndex & { revision: number }>(`${base}/index`);
      revision = value.revision;
      const index = { pages: value.pages, trash: value.trash ?? [], activeId: value.pages[0]?.id ?? '', access: value.access };
      baseline = snapshot(index); acknowledged = snapshot(index);
      return index;
    },
    async readPageAccess(id: string) {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      const index = await request<WorkspaceIndex>(`${base}/index`);
      const entry = index.access?.[id];
      if (!entry) throw new Error('Page not found');
      return entry;
    },
    async refreshIndex(accept: () => boolean, signal?: AbortSignal): Promise<WorkspaceIndex | null> {
      if (ref.kind !== 'remote') return null;
      const value = await request<WorkspaceIndex & {revision: number}>(`${base}/index`, {signal});
      // A focus refresh can finish after our PUT has already committed. Its older
      // snapshot would rewind both the sidebar and the next conditional write.
      if (!accept() || (revision !== null && value.revision < revision)) return null;
      revision = value.revision;
      const index = {pages:value.pages,trash:value.trash ?? [],activeId:value.pages[0]?.id ?? '',access:value.access};
      baseline = snapshot(index); acknowledged = snapshot(index);
      return index;
    },
    async saveIndex(value: WorkspaceIndex): Promise<WorkspaceIndex> {
      if (ref.kind === 'local') { await writeFile('index', JSON.stringify(value), ref); return value; }
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
    async movePage(index: WorkspaceIndex, sourceId: string, parentId: string | null): Promise<void> {
      const source = index.pages.find((page) => page.id === sourceId);
      if (!source) throw new PageMoveConflict();
      const originalParent = source.parentId;
      const intent = snapshot(index);
      intent.pages.find((page) => page.id === sourceId)!.parentId = parentId;
      const fresh = ref.kind === 'remote' ? await request<WorkspaceIndex & {revision: number}>(`${base}/index`) : undefined;
      const current = fresh ?? index;
      const page = current.pages.find((item) => item.id === sourceId);
      if (!page || page.parentId !== originalParent || !moveDestinations(current.pages, sourceId, pageAccess(ref, current.access)).has(parentId)) {
        throw new PageMoveConflict();
      }
      if (!fresh) { await writeFile('index', JSON.stringify(intent), ref); return; }
      // A move can change inherited rights. Revalidate against this exact index
      // revision and let the user pick again if a concurrent edit wins.
      const pages = fresh.pages.map((item) => item.id === sourceId ? { ...item, parentId } : item);
      try {
        const saved = await request<{revision: number}>(`${base}/index`, {
          method: 'PUT', body: JSON.stringify({ pages, trash: fresh.trash ?? [], revision: fresh.revision }),
        });
        revision = saved.revision;
        baseline = intent;
        acknowledged = snapshot({ ...fresh, pages, activeId: intent.activeId });
      } catch (error) {
        if (error instanceof RepositoryHttpError && error.status === 409) throw new PageMoveConflict();
        throw error;
      }
    },
    readPage(id: string) {
      if (ref.kind !== 'local') throw new Error('Remote documents require collaboration');
      return (pageWrites.get(id) ?? Promise.resolve()).then(() => readFile(id, ref));
    },
    writePage(id: string, data: string) {
      if (ref.kind !== 'local') throw new Error('Remote documents require collaboration');
      const pending = (pageWrites.get(id) ?? Promise.resolve()).then(() => writeFile(id, data, ref));
      pageWrites.set(id, pending);
      return pending;
    },
    async importMarkdown(attempt: string, name: string, source: string): Promise<string> {
      if (ref.kind === 'remote') {
        const body = JSON.stringify({attempt, name, source});
        if (new Blob([body]).size > (8 << 20)) throw new Error('Ce fichier dépasse la taille acceptée par le serveur (8 Mio).');
        try {
          return (await request<{id: string}>(`${base}/import/markdown`, {method: 'POST', body})).id;
        } catch (error) {
          if (error instanceof RepositoryHttpError && error.status === 403) throw new Error('Vous ne pouvez pas créer de page dans cet espace.');
          if (error instanceof RepositoryHttpError && error.status === 422) throw new Error('Ce document Markdown contient des blocs impossibles à importer.');
          throw error;
        }
      }
      const id = attempt;
      const index = await loadIndex(ref);
      if (index.pages.some(page => page.id === id)) return id;
      if (index.trash?.some(page => page.id === id)) throw new Error('La page importée se trouve dans la corbeille.');
      const {markdownPage} = await import('../../src/markdown/import-page');
      const document = await markdownPage(name, source);
      if (await readFile(id, ref) === null) await writeFile(id, JSON.stringify(document), ref);
      const page = {id, title: document.title, parentId: null, ...(document.icon?.type === 'emoji' ? {icon: document.icon.value} : {})};
      // Publish the index only once the document exists. A failed index write can be retried with the same id.
      await saveIndex({...index, pages: [...index.pages, page]}, ref);
      return id;
    },
    async seedPage(id: string, document: unknown): Promise<void> {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      await request(`${base}/pages/${encodeURIComponent(id)}/seed`, {method: 'POST', body: JSON.stringify({document})});
    },
    async duplicatePage(source: string, page: {id: string; title: string; parentId: string | null}): Promise<void> {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      await request(`${base}/pages/${encodeURIComponent(source)}/duplicate`, {method: 'POST', body: JSON.stringify(page)});
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
||||||| f8ef3c6b39
=======
import { mergeWorkspaceIndex } from './workspace-merge';
import { loadIndex, readFile, writeFile, type WorkspaceIndex } from './storage';
import { nativeSessionAdapter } from './native-session';
import type { WorkspaceRef } from './workspace-registry';
class RepositoryHttpError extends Error { constructor(public status: number) { super(`Serveur indisponible (${status})`); } }
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
    if (!response.ok) throw new RepositoryHttpError(response.status);
    return await response.json() as T;
  }
  return {
    ref,
    async loadIndex(): Promise<WorkspaceIndex> {
      if (ref.kind === 'local') return loadIndex(ref);
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
      if (ref.kind === 'local') { await writeFile('index', JSON.stringify(value), ref); return value; }
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
    readPage(id: string) {
      if (ref.kind !== 'local') throw new Error('Remote documents require collaboration');
      return (pageWrites.get(id) ?? Promise.resolve()).then(() => readFile(id, ref));
    },
    writePage(id: string, data: string) {
      if (ref.kind !== 'local') throw new Error('Remote documents require collaboration');
      const pending = (pageWrites.get(id) ?? Promise.resolve()).then(() => writeFile(id, data, ref));
      pageWrites.set(id, pending);
      return pending;
    },
    async seedPage(id: string, document: unknown): Promise<void> {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      await request(`${base}/pages/${encodeURIComponent(id)}/seed`, {method: 'POST', body: JSON.stringify({document})});
    },
    async duplicatePage(source: string, page: {id: string; title: string; parentId: string | null}): Promise<void> {
      if (ref.kind !== 'remote') throw new Error('Remote operation only');
      await request(`${base}/pages/${encodeURIComponent(source)}/duplicate`, {method: 'POST', body: JSON.stringify(page)});
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
>>>>>>> origin/fix/self-host-review
