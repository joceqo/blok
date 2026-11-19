import type { API } from '../../types';
import type { BlokConfig } from '../../types/configs';
import type { DatabaseRowPages } from '../../types/tools/database';
import { measurePeek, peekProfileFor } from '../../src/components/utils/peek-profile';

/** Only the editor surface needed by a mounted row body. */
export interface RowPageEditor {
  blocks?: API['blocks'];
  isReady: Promise<unknown>;
  readOnly: { set(state: boolean): Promise<boolean> };
  saver: { flush(): Promise<unknown> };
  destroy(): void;
}

export interface DesktopRowPagesOptions {
  navigate?: DatabaseRowPages['navigate'];
  navigation?: DatabaseRowPages['navigation'];
  href?: DatabaseRowPages['href'];
  snapshot?: DatabaseRowPages['snapshot'];
  mountEmpty?: DatabaseRowPages['mountEmpty'];
  hasDraft?: DatabaseRowPages['hasDraft'];
  lookup: DatabaseRowPages['lookup'];
  copyFromLegacy: DatabaseRowPages['copyFromLegacy'];
  reconcileLegacy: DatabaseRowPages['reconcileLegacy'];
  /** Supply the host's scoped persistence or collaboration/ticket configuration. */
  editorConfig(pageId: string): Omit<BlokConfig, 'holder' | 'readOnly'>;
  createEditor(config: BlokConfig): RowPageEditor;
  readOnly(pageId: string): boolean;
  watchReadOnly?(pageId: string, changed: () => void): () => void;
  onError?(error: unknown, pageId: string): void;
  /** Keep a few ready editors alive after their peek closes. Zero keeps the old lifecycle. */
  retainEditors?: number;
}

export interface DesktopRowPages extends DatabaseRowPages {
  mountedEditor(pageId: string): RowPageEditor | undefined;
  flush(): Promise<void>;
  destroy(): void;
}

/** Bodies use ordinary page editors and their existing offline/outbox lifecycle. */
export function createDesktopRowPages(options: DesktopRowPagesOptions): DesktopRowPages {
  interface Entry {
    pageId: string;
    editor: RowPageEditor;
    surface: HTMLElement;
    ready: boolean;
    active: boolean;
    visited: boolean;
    disposed: boolean;
    unwatch?: () => void;
    refreshPermissions(): void;
  }
  const mounts = new Set<Entry>();
  const idle = new Map<string, Entry>();
  const retain = Math.max(0, Math.floor(options.retainEditors ?? 0));
  const parked = document.createElement('div');

  if (retain > 0) {
    parked.hidden = true;
    parked.setAttribute('inert', '');
    document.body.append(parked);
  }
  let destroyed = false;

  const dispose = (entry: Entry): void => {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.active = false;
    mounts.delete(entry);
    if (idle.get(entry.pageId) === entry) idle.delete(entry.pageId);
    try { entry.unwatch?.(); } finally {
      try { entry.editor.destroy(); } finally {
        if (retain > 0) entry.surface.remove();
      }
    }
  };

  const release = (entry: Entry): void => {
    if (!entry.active || entry.disposed) return;
    entry.active = false;
    mounts.delete(entry);
    if (destroyed || retain === 0) {
      dispose(entry);

      return;
    }
    entry.surface.hidden = true;
    parked.append(entry.surface);
    const previous = idle.get(entry.pageId);

    if (previous !== undefined) dispose(previous);
    idle.set(entry.pageId, entry);
    while (idle.size > retain) dispose(idle.values().next().value as Entry);
  };

  const createEntry = (pageId: string, holder: HTMLElement, active: boolean): Entry => {
    const surface = retain > 0 ? document.createElement('div') : holder;

    if (surface !== holder) holder.append(surface);
    let editor: RowPageEditor;

    try {
      editor = measurePeek(peekProfileFor(holder), 'hostEditorCreate', () => options.createEditor({
        ...options.editorConfig(pageId),
        holder: surface,
        readOnly: options.readOnly(pageId),
      }));
    } catch (error) {
      if (retain > 0) surface.remove();
      throw error;
    }
    // Permission transitions may themselves await work; serialize them so an
    // older transition cannot finish after the latest permission is applied.
    let permissions = Promise.resolve();
    const entry: Entry = {
      pageId, editor, surface, ready: false, active, visited: active, disposed: false,
      refreshPermissions() {
        if (!entry.ready || entry.disposed) return;
        permissions = permissions.then(async () => {
          if (!entry.disposed) await editor.readOnly.set(options.readOnly(pageId));
        }).catch(fail);
      },
    };
    const fail = (error: unknown): void => {
      if (entry.disposed) return;
      const wasActive = entry.active;

      dispose(entry);
      if (!wasActive) return;
      if (options.onError) options.onError(error, pageId);
      else console.error('Unable to open row page', pageId, error);
    };

    if (active) mounts.add(entry);
    else idle.set(pageId, entry);
    try {
      entry.unwatch = options.watchReadOnly?.(pageId, entry.refreshPermissions);
    } catch (error) {
      dispose(entry);
      throw error;
    }
    void editor.isReady.then(() => {
      if (entry.disposed) return;
      peekProfileFor(entry.surface)?.mark('editorReady');
      entry.ready = true;
      entry.refreshPermissions();
    }).catch(fail);

    return entry;
  };

  return {
    ...(options.navigate ? {navigate: options.navigate} : {}),
    ...(options.navigation ? {navigation: options.navigation} : {}),
    ...(options.href ? {href: options.href} : {}),
    ...(options.snapshot ? {snapshot: options.snapshot} : {}),
    ...(options.mountEmpty ? {mountEmpty: options.mountEmpty} : {}),
    ...(options.hasDraft ? {hasDraft: options.hasDraft} : {}),
    lookup: input => options.lookup(input),
    copyFromLegacy: input => options.copyFromLegacy(input),
    reconcileLegacy: input => options.reconcileLegacy(input),
    prepare(pageId, preparation) {
      if (destroyed || retain === 0 || idle.has(pageId) || [...mounts].some(entry => entry.pageId === pageId)) return;
      // An inline peek has no entry in this host's mounts. It still owns the
      // foreground: speculative editors must not compete with its first paint.
      if (mounts.size > 0 || document.querySelector('[data-blok-database-drawer]') !== null) return;
      if (idle.size >= retain) {
        if (preparation?.ifRoom) return;
        const speculative = [...idle.values()].find(entry => !entry.visited);

        if (speculative === undefined) return;
        dispose(speculative);
      }
      try {
        createEntry(pageId, parked, false);
        while (idle.size > retain) dispose(idle.values().next().value as Entry);
      } catch {
        // Hover preparation is speculative. The visible mount reports a real error.
      }
    },
    isReady(pageId) { return idle.get(pageId)?.ready === true; },
    mountedEditor(pageId) {
      return [...mounts].find(entry => entry.pageId === pageId && entry.active && !entry.disposed)?.editor;
    },

    mount(pageId, holder) {
      if (destroyed) throw new Error('Row pages host has been destroyed');
      const cached = idle.get(pageId);

      if (cached !== undefined) {
        peekProfileFor(holder)?.mark('cacheHit');
        if (cached.ready) peekProfileFor(holder)?.mark('cachedEditorReady');
        idle.delete(pageId);
        cached.surface.hidden = false;
        holder.append(cached.surface);
        cached.active = true;
        cached.visited = true;
        mounts.add(cached);
        cached.refreshPermissions();

        return { destroy: () => release(cached) };
      }
      peekProfileFor(holder)?.mark('cacheMiss');
      const entry = createEntry(pageId, holder, true);

      return { destroy: () => release(entry) };
    },

    async flush() {
      await Promise.all([...mounts, ...idle.values()].map(async entry => {
        await entry.editor.isReady;
        if (!entry.disposed) await entry.editor.saver.flush();
      }));
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const entry of [...mounts, ...idle.values()]) dispose(entry);
      parked.remove();
    },
  };
}
