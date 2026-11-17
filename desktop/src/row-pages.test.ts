import { expect, it, vi } from 'vitest';
import { createDesktopRowPages, type RowPageEditor } from './row-pages';
import { bindPeekProfile, startPeekProfile } from '../../src/components/utils/peek-profile';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('reports cold construction separately from cached editor reuse', async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  history.replaceState(null, '', '/?profile=1');
  const h = harness(2);
  const holder = document.createElement('div');
  const cold = startPeekProfile('side');
  let warm: ReturnType<typeof startPeekProfile>;
  bindPeekProfile(holder, cold);
  try {
    const mount = h.pages.mount('body', holder);
    expect(cold?.record.milestones.cacheMiss).toBeDefined();
    expect(cold?.record.spans.map(span => span.name)).toContain('hostEditorCreate');
    expect(cold?.record.milestones.editorReady).toBeUndefined();
    h.ready.resolve();
    await Promise.resolve();
    expect(cold?.record.milestones.editorReady).toBeDefined();
    expect(cold?.record.milestones.contentInteractive).toBeUndefined();
    mount.destroy();
    cold?.finish('closed');
    warm = startPeekProfile('side');
    bindPeekProfile(holder, warm);
    h.pages.mount('body', holder);
    expect(warm?.record.milestones.cacheHit).toBeDefined();
    expect(warm?.record.milestones.cachedEditorReady).toBeDefined();
    expect(warm?.record.spans).toEqual([]);
    expect(h.createEditor).toHaveBeenCalledTimes(1);
  } finally {
    h.pages.destroy();
    cold?.finish('closed');
    warm?.finish('closed');
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    history.replaceState(null, '', '/');
  }
});

function harness(retainEditors = 0) {
  const ready = deferred();
  const editor: RowPageEditor = {
    isReady: ready.promise,
    readOnly: { set: vi.fn(async () => true) },
    saver: { flush: vi.fn(async () => {}) },
    destroy: vi.fn(),
  };
  const lookup = vi.fn(async () => null);
  const copyFromLegacy = vi.fn();
  const reconcileLegacy = vi.fn();
  const ticket = vi.fn(async () => 'ticket');
  const editorConfig = vi.fn((pageId: string) => ({
    documentId: `workspace:${pageId}`,
    server: 'https://example.test/api/blok',
    ticket,
    collaboration: { doc: pageId, offline: true, offlineScope: 'workspace' },
  }));
  const createEditor = vi.fn(() => editor);
  const onError = vi.fn();
  let readOnly = false;
  let permissionChanged: (() => void) | undefined;
  const unwatch = vi.fn();
  const pages = createDesktopRowPages({
    lookup, copyFromLegacy, reconcileLegacy, editorConfig, createEditor, onError,
    retainEditors,
    readOnly: () => readOnly,
    watchReadOnly: (_pageId, changed) => { permissionChanged = changed; return unwatch; },
  });
  return { pages, ready, editor, lookup, copyFromLegacy, reconcileLegacy,
    editorConfig, createEditor, ticket, onError, unwatch,
    permission(value: boolean) { readOnly = value; permissionChanged?.(); },
  };
}

it('does no discovery or editor work until a particular body is opened', () => {
  const h = harness();
  expect(h.lookup).not.toHaveBeenCalled();
  expect(h.createEditor).not.toHaveBeenCalled();
  const holder = document.createElement('div');
  const mounted = h.pages.mount('body-a', holder);
  expect(h.editorConfig).toHaveBeenCalledExactlyOnceWith('body-a');
  expect(h.createEditor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    holder, readOnly: false, documentId: 'workspace:body-a', ticket: h.ticket,
    collaboration: { doc: 'body-a', offline: true, offlineScope: 'workspace' },
  }));
  expect(h.lookup).not.toHaveBeenCalled();
  expect(h.ticket).not.toHaveBeenCalled();
  mounted.destroy();
});

it('reuses a ready editor and its DOM on reopen, then destroys it with the workspace', async () => {
  const h = harness(2);
  const firstHolder = document.createElement('div');
  const first = h.pages.mount('body', firstHolder);
  const surface = firstHolder.firstElementChild;

  expect(surface).toBeInstanceOf(HTMLElement);
  h.ready.resolve();
  await vi.waitFor(() => expect(h.editor.readOnly.set).toHaveBeenCalledWith(false));
  first.destroy();
  expect(h.editor.destroy).not.toHaveBeenCalled();
  expect(firstHolder.children).toHaveLength(0);

  const secondHolder = document.createElement('div');

  h.permission(true);
  const second = h.pages.mount('body', secondHolder);

  expect(h.createEditor).toHaveBeenCalledTimes(1);
  expect(secondHolder.firstElementChild).toBe(surface);
  expect((surface as HTMLElement).hidden).toBe(false);
  await vi.waitFor(() => expect(h.editor.readOnly.set).toHaveBeenLastCalledWith(true));
  second.destroy();
  await h.pages.flush();
  expect(h.editor.saver.flush).toHaveBeenCalledTimes(1);
  h.pages.destroy();
  expect(h.editor.destroy).toHaveBeenCalledTimes(1);
  expect(surface?.isConnected).toBe(false);
});

it('uses the editor started on hover even when the row opens before it is ready', async () => {
  const h = harness(2);

  h.pages.prepare?.('body');
  h.pages.prepare?.('body');
  expect(h.createEditor).toHaveBeenCalledTimes(1);
  expect(h.pages.isReady?.('body')).toBe(false);
  const holder = document.createElement('div');
  const mounted = h.pages.mount('body', holder);

  expect(h.createEditor).toHaveBeenCalledTimes(1);
  expect(holder.childElementCount).toBe(1);
  h.ready.resolve();
  await vi.waitFor(() => expect(h.editor.readOnly.set).toHaveBeenCalled());
  mounted.destroy();
  expect(h.pages.isReady?.('body')).toBe(true);
  h.pages.destroy();
});

it('visible-row preparation does not evict a body already in the cache', () => {
  const h = harness(1);

  h.pages.prepare?.('body-a');
  h.pages.prepare?.('body-b', { ifRoom: true });
  expect(h.createEditor).toHaveBeenCalledTimes(1);
  expect(h.editor.destroy).not.toHaveBeenCalled();
  h.pages.destroy();
});

it('evicts the oldest idle editor when the retention limit is reached', async () => {
  const editors: RowPageEditor[] = [];
  const pages = createDesktopRowPages({
    retainEditors: 1,
    lookup: async () => null,
    copyFromLegacy: async () => { throw new Error('unused'); },
    reconcileLegacy: async () => { throw new Error('unused'); },
    editorConfig: pageId => ({ documentId: pageId }),
    createEditor: () => {
      const editor: RowPageEditor = {
        isReady: Promise.resolve(),
        readOnly: { set: vi.fn(async () => true) },
        saver: { flush: vi.fn(async () => {}) },
        destroy: vi.fn(),
      };

      editors.push(editor);
      return editor;
    },
    readOnly: () => false,
  });
  const first = pages.mount('first', document.createElement('div'));

  await Promise.resolve();
  first.destroy();
  const second = pages.mount('second', document.createElement('div'));

  await Promise.resolve();
  second.destroy();
  expect(editors[0]?.destroy).toHaveBeenCalledTimes(1);
  expect(editors[1]?.destroy).not.toHaveBeenCalled();
  pages.destroy();
  expect(editors[1]?.destroy).toHaveBeenCalledTimes(1);
});

it('delegates migration operations without inventing another body cache', async () => {
  const h = harness();
  const body = { blocks: [] };
  const copy = { rowId: 'row', operationId: 'op', body };
  const reconcile = { ...copy, pageId: 'body', acceptedBody: body };
  await h.pages.lookup({ rowId: 'row' });
  await h.pages.copyFromLegacy(copy);
  await h.pages.reconcileLegacy(reconcile);
  expect(h.lookup).toHaveBeenCalledExactlyOnceWith({ rowId: 'row' });
  expect(h.copyFromLegacy).toHaveBeenCalledExactlyOnceWith(copy);
  expect(h.reconcileLegacy).toHaveBeenCalledExactlyOnceWith(reconcile);
  expect(h.createEditor).not.toHaveBeenCalled();
});

it('destroys an initializing editor once and ignores late initialization and permission callbacks', async () => {
  const h = harness();
  const mounted = h.pages.mount('body', document.createElement('div'));
  mounted.destroy();
  mounted.destroy();
  h.permission(true);
  h.ready.resolve();
  await h.ready.promise;
  await Promise.resolve();
  expect(h.editor.destroy).toHaveBeenCalledTimes(1);
  expect(h.unwatch).toHaveBeenCalledTimes(1);
  expect(h.editor.readOnly.set).not.toHaveBeenCalled();
  expect(h.onError).not.toHaveBeenCalled();
});

it('uses current permissions after initialization and applies changes to an open body', async () => {
  const h = harness();
  const mounted = h.pages.mount('body', document.createElement('div'));
  h.permission(true);
  expect(h.editor.readOnly.set).not.toHaveBeenCalled();
  h.ready.resolve();
  await h.ready.promise;
  await vi.waitFor(() => expect(h.editor.readOnly.set).toHaveBeenCalledWith(true));
  h.permission(false);
  await vi.waitFor(() => expect(h.editor.readOnly.set).toHaveBeenLastCalledWith(false));
  mounted.destroy();
});

it('reports initialization failure and releases that mount without an unhandled rejection', async () => {
  const h = harness();
  h.pages.mount('body', document.createElement('div'));
  const error = new Error('Access revoked');
  h.ready.reject(error);
  await vi.waitFor(() => expect(h.onError).toHaveBeenCalledExactlyOnceWith(error, 'body'));
  expect(h.editor.destroy).toHaveBeenCalledTimes(1);
  expect(h.unwatch).toHaveBeenCalledTimes(1);
});

it('suppresses initialization errors after the drawer was closed', async () => {
  const h = harness();
  h.pages.mount('body', document.createElement('div')).destroy();
  h.ready.reject(new Error('Cancelled'));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.onError).not.toHaveBeenCalled();
});

it('flushes active bodies through the existing saver and destroys all mounts on workspace teardown', async () => {
  const h = harness();
  h.pages.mount('body', document.createElement('div'));
  const flushing = h.pages.flush();
  expect(h.editor.saver.flush).not.toHaveBeenCalled();
  h.ready.resolve();
  await flushing;
  expect(h.editor.saver.flush).toHaveBeenCalledTimes(1);
  h.pages.destroy();
  h.pages.destroy();
  expect(h.editor.destroy).toHaveBeenCalledTimes(1);
  expect(() => h.pages.mount('another', document.createElement('div'))).toThrow();
  await h.pages.flush();
  expect(h.editor.saver.flush).toHaveBeenCalledTimes(1);
});
