import type { BlokConfig } from '../../types/configs';
import type { DatabaseRowPages } from '../../types/tools/database';

/** Only the editor surface needed by a mounted row body. */
export interface RowPageEditor {
  isReady: Promise<unknown>;
  readOnly: { set(state: boolean): Promise<boolean> };
  saver: { flush(): Promise<unknown> };
  destroy(): void;
}

export interface DesktopRowPagesOptions {
  snapshot?: DatabaseRowPages['snapshot'];
  lookup: DatabaseRowPages['lookup'];
  copyFromLegacy: DatabaseRowPages['copyFromLegacy'];
  reconcileLegacy: DatabaseRowPages['reconcileLegacy'];
  /** Supply the host's scoped persistence or collaboration/ticket configuration. */
  editorConfig(pageId: string): Omit<BlokConfig, 'holder' | 'readOnly'>;
  createEditor(config: BlokConfig): RowPageEditor;
  readOnly(pageId: string): boolean;
  watchReadOnly?(pageId: string, changed: () => void): () => void;
  onError?(error: unknown, pageId: string): void;
}

export interface DesktopRowPages extends DatabaseRowPages {
  flush(): Promise<void>;
  destroy(): void;
}

/** Bodies use ordinary page editors and their existing offline/outbox lifecycle. */
export function createDesktopRowPages(options: DesktopRowPagesOptions): DesktopRowPages {
  const mounts = new Set<{ editor: RowPageEditor; destroy(): void }>();
  let destroyed = false;

  return {
    ...(options.snapshot ? {snapshot: options.snapshot} : {}),
    lookup: input => options.lookup(input),
    copyFromLegacy: input => options.copyFromLegacy(input),
    reconcileLegacy: input => options.reconcileLegacy(input),

    mount(pageId, holder) {
      if (destroyed) throw new Error('Row pages host has been destroyed');
      const editor = options.createEditor({
        ...options.editorConfig(pageId),
        holder,
        readOnly: options.readOnly(pageId),
      });
      let disposed = false;
      let ready = false;
      let unwatch: (() => void) | undefined;
      // Permission transitions may themselves await work; serialize them so an
      // older transition cannot finish after the latest permission is applied.
      let permissions = Promise.resolve();
      const mounted = {
        editor,
        destroy() {
          if (disposed) return;
          disposed = true;
          mounts.delete(mounted);
          try { unwatch?.(); } finally { editor.destroy(); }
        },
      };
      const fail = (error: unknown): void => {
        if (disposed) return;
        mounted.destroy();
        if (options.onError) options.onError(error, pageId);
        else console.error('Unable to open row page', pageId, error);
      };
      const refreshPermissions = (): void => {
        if (!ready || disposed) return;
        permissions = permissions.then(async () => {
          if (!disposed) await editor.readOnly.set(options.readOnly(pageId));
        }).catch(fail);
      };

      mounts.add(mounted);
      try {
        unwatch = options.watchReadOnly?.(pageId, refreshPermissions);
      } catch (error) {
        mounted.destroy();
        throw error;
      }
      void editor.isReady.then(() => {
        if (disposed) return;
        ready = true;
        refreshPermissions();
      }).catch(fail);

      return { destroy: () => mounted.destroy() };
    },

    async flush() {
      await Promise.all([...mounts].map(async mounted => {
        await mounted.editor.isReady;
        if (mounts.has(mounted)) await mounted.editor.saver.flush();
      }));
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const mounted of [...mounts]) mounted.destroy();
    },
  };
}
