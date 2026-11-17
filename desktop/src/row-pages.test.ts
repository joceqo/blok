import { expect, it, vi } from 'vitest';
import { createDesktopRowPages, type RowPageEditor } from './row-pages';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
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
