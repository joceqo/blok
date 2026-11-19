import type { OutputData } from '../../types';

export interface RowDraftRequest { documentId: string; rowId: string; operationId: string; body: OutputData }
interface DraftEditor {
  isReady: Promise<unknown>;
  save(): Promise<OutputData>;
  readOnly?: { set(value: boolean): Promise<unknown> };
  destroy(): void;
}
interface PageMount { destroy(): void; ready?: Promise<unknown> }
interface DraftRecord { body: OutputData; operationId?: string; snapshot?: OutputData; pageId?: string }
interface Options {
  scope: string;
  storage?: Storage;
  readOnly(documentId: string): boolean;
  create(input: RowDraftRequest): Promise<{pageId: string}>;
  createEditor(input: {holder: HTMLElement; data: OutputData; readOnly: boolean; onChange(): void}): DraftEditor;
  mountPage(pageId: string, holder: HTMLElement): PageMount;
}

/** Paragraph placeholders, blank lines and whitespace are not page content. */
export function hasRowDraftContent(body: OutputData): boolean {
  const text = (value: unknown): string => {
    if (typeof value === 'string') {
      const node = document.createElement('div'); node.innerHTML = value;
      return node.textContent?.replace(/[\s\u200B-\u200D\uFEFF]/g, '') ?? '';
    }
    if (Array.isArray(value)) return value.map(part => typeof part === 'object' && part !== null ? text(Reflect.get(part, 'text')) : text(part)).join('');
    return '';
  };
  return body.blocks.some(block => block.type !== 'database-comment' && (block.type !== 'paragraph' || text(block.data.text).length > 0));
}

/** Local drafts are separate from the collaborative source document. A pending
 * snapshot never changes: retries must replay exactly the same operation. */
export function createRowBodyDrafts(options: Options) {
  const storage = options.storage ?? localStorage;
  interface Surface {
    root: HTMLElement; status: HTMLElement; editorHost: HTMLElement; editor: DraftEditor;
    draftDestroyed?: boolean; active: boolean; generation: number; composing: boolean; focusBlock?: string; page?: PageMount; switching?: Promise<void>;
  }
  interface Entry {
    key: string; documentId: string; rowId: string; record: DraftRecord;
    surface?: Surface; capture?: Promise<void>; uploading?: Promise<void>; error?: string;
  }
  const entries = new Map<string, Entry>();
  let destroyed = false;
  const keyFor = (documentId: string, rowId: string): string => `blok-row-draft:${JSON.stringify([options.scope, documentId, rowId])}`;
  const read = (key: string): DraftRecord => {
    const raw = storage.getItem(key);
    if (!raw) return {body: {blocks: []}};
    const record = JSON.parse(raw) as DraftRecord;
    if (!Array.isArray(record.body?.blocks) || (record.snapshot && (!record.operationId || !Array.isArray(record.snapshot.blocks)))) throw new Error('Brouillon local illisible. Ne fermez pas cette fenêtre.');
    return record;
  };
  const persist = (entry: Entry, record: DraftRecord): void => {
    storage.setItem(entry.key, JSON.stringify(record));
    entry.record = record;
  };
  const dispose = (entry: Entry): void => {
    const surface = entry.surface;
    if (!surface) return;
    entry.surface = undefined;
    surface.page?.destroy(); if (!surface.draftDestroyed) surface.editor.destroy(); surface.root.remove();
  };
  const focusBody = (surface: Surface): void => {
    const scope = surface.page ? surface.root : surface.editorHost;
    const block = surface.focusBlock ? scope.querySelector(`[data-blok-id="${CSS.escape(surface.focusBlock)}"]`) : scope;
    const input = block?.querySelector<HTMLElement>('[contenteditable="true"]') ?? scope.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!input) return;
    input.focus({preventScroll: true});
    const range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
    getSelection()?.removeAllRanges(); getSelection()?.addRange(range);
  };
  const paint = (entry: Entry): void => {
    const surface = entry.surface;
    if (!surface) return;
    surface.status.replaceChildren();
    const busy = entry.uploading !== undefined || entry.capture !== undefined || surface.switching !== undefined;
    surface.root.setAttribute('aria-busy', String(busy));
    const pending = entry.record.snapshot !== undefined || entry.record.pageId !== undefined;
    if (!busy && !pending && !entry.error && !hasRowDraftContent(entry.record.body)) { surface.status.hidden = true; return; }
    surface.status.hidden = false;
    const label = document.createElement('span');
    label.textContent = entry.error ? `Brouillon conservé sur cet appareil : ${entry.error}` : busy ? 'Enregistrement du contenu…' : 'Brouillon conservé sur cet appareil.';
    surface.status.append(label);
    if (!busy && !options.readOnly(entry.documentId)) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Réessayer'; retry.setAttribute('data-row-draft-retry', '');
      retry.addEventListener('click', () => { entry.error = undefined; if (entry.record.pageId) void attachPage(entry); else if (entry.record.snapshot) upload(entry); else capture(entry); });
      surface.status.append(retry);
    }
  };
  const fail = (entry: Entry, error: unknown): void => {
    entry.error = error instanceof Error ? error.message : 'Enregistrement impossible. Réessayez.';
    const surface = entry.surface;
    if (surface && entry.record.snapshot && surface.editor.readOnly) {
      void surface.editor.readOnly.set(true).then(() => { surface.editorHost.removeAttribute('inert'); }).catch(() => undefined);
    }
    paint(entry);
  };
  const attachPage = async (entry: Entry): Promise<void> => {
    const surface = entry.surface;
    if (destroyed || !surface?.active || !entry.record.pageId || surface.switching || surface.page) return;
    const next = document.createElement('div');
    next.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:100%';
    surface.root.append(next);
    let page: PageMount | undefined;
    surface.switching = (async () => {
      try {
        page = options.mountPage(entry.record.pageId!, next);
        await page.ready;
        if (destroyed || entry.surface !== surface || !surface.active) { page.destroy(); next.remove(); return; }
        const restoreFocus = surface.focusBlock !== undefined;
        // Clear persisted recovery data only after the ordinary body is ready,
        // and before disposing the still-visible draft (storage can throw).
        storage.removeItem(entry.key);
        surface.draftDestroyed = true; surface.editor.destroy(); surface.editorHost.remove(); next.removeAttribute('style');
        surface.page = page;
        surface.status.hidden = true;
        entry.record = {body: {blocks: []}};
        if (restoreFocus) focusBody(surface);
      } catch (error) {
        page?.destroy(); next.remove(); fail(entry, error);
      } finally { surface.switching = undefined; paint(entry); }
    })();
    paint(entry);
    await surface.switching;
  };
  const upload = (entry: Entry): void => {
    if (entry.uploading || !entry.record.snapshot || !entry.record.operationId || options.readOnly(entry.documentId)) return;
    const request: RowDraftRequest = {documentId:entry.documentId,rowId:entry.rowId,operationId:entry.record.operationId,body:entry.record.snapshot};
    entry.uploading = Promise.resolve().then(() => options.create(request)).then(receipt => {
      persist(entry, {...entry.record, pageId:receipt.pageId});
      if (entry.surface?.active && !destroyed) void attachPage(entry);
      else dispose(entry);
    }).catch(error => fail(entry, error)).finally(() => { entry.uploading = undefined; paint(entry); });
    paint(entry);
  };
  const capture = (entry: Entry): void => {
    const surface = entry.surface;
    if (!surface || entry.capture || entry.record.snapshot || entry.record.pageId || surface.page || surface.composing) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && surface.editorHost.contains(active)) surface.focusBlock = active.closest('[data-blok-id]')?.getAttribute('data-blok-id') ?? '';
    // Freeze before the async save, so its immutable snapshot includes every
    // accepted edit. A visible status explains why typing is suspended.
    surface.editorHost.setAttribute('inert', '');
    entry.capture = Promise.resolve().then(async () => {
      await surface.editor.isReady;
      const body = await surface.editor.save();
      persist(entry, {body});
      if (!hasRowDraftContent(body)) { surface.editorHost.removeAttribute('inert'); return; }
      const snapshot = JSON.parse(JSON.stringify(body)) as OutputData;
      persist(entry, {body, snapshot, operationId: crypto.randomUUID()});
      upload(entry);
    }).catch(error => fail(entry, error)).finally(() => {
      entry.capture = undefined;
      if (!surface.active && !entry.record.snapshot && !entry.error) dispose(entry);
      paint(entry);
    });
    paint(entry);
  };
  return {
    hasDraft(documentId: string, rowId: string): boolean {
      const key = keyFor(documentId, rowId);
      const entry = entries.get(key);
      try {
        const record = entry?.record ?? read(key);
        return entry?.capture !== undefined || record.snapshot !== undefined || record.pageId !== undefined || hasRowDraftContent(record.body);
      } catch { return true; } // Never overwrite an unreadable saved draft.
    },
    mount(documentId: string, rowId: string, holder: HTMLElement) {
      if (destroyed) throw new Error('Draft host has been destroyed');
      const key = keyFor(documentId, rowId);
      let entry = entries.get(key);
      if (!entry) { entry = {key, documentId, rowId, record:read(key)}; entries.set(key, entry); }
      const current = entry;
      if (!current.surface) {
        const root = document.createElement('div'); root.setAttribute('data-row-body-draft', ''); root.style.position = 'relative';
        const status = document.createElement('div'); status.setAttribute('role','status'); status.style.cssText='display:flex;gap:12px;align-items:center;padding:8px 0;font-size:13px';
        const editorHost = document.createElement('div'); root.append(status, editorHost); holder.append(root);
        const editor = options.createEditor({holder:editorHost,data:current.record.body,readOnly:options.readOnly(documentId) || current.record.snapshot !== undefined,onChange:()=>capture(current)});
        current.surface = {root,status,editorHost,editor,active:true,generation:0,composing:false};
        editorHost.addEventListener('compositionstart', () => { if(current.surface)current.surface.composing=true; });
        editorHost.addEventListener('compositionend', () => { if(current.surface)current.surface.composing=false; capture(current); });
        editorHost.addEventListener('input', () => capture(current));
        void editor.isReady.catch(error => fail(current,error));
      }
      const surface = current.surface;
      surface.active = true; const generation = ++surface.generation; holder.append(surface.root);
      paint(current);
      if (current.record.pageId) void attachPage(current);
      return {
        focus() { if (surface.page) { focusBody(surface); return; } void surface.editor.isReady.then(() => { if(surface.active && !current.record.snapshot)focusBody(surface); }); },
        destroy() {
          if (surface.generation !== generation || !surface.active) return;
          surface.active = false; capture(current); surface.root.remove();
          if (surface.page) dispose(current);
        },
      };
    },
    refreshPermissions() {
      for (const entry of entries.values()) {
        const surface = entry.surface;
        if (surface && !surface.draftDestroyed) void surface.editor.readOnly?.set(options.readOnly(entry.documentId) || entry.record.snapshot !== undefined).catch(error => fail(entry,error));
      }
    },
    async flush() { await Promise.all([...entries.values()].map(entry => entry.capture)); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const entry of entries.values()) {
        capture(entry);
        void Promise.resolve(entry.capture).finally(() => dispose(entry));
      }
    },
  };
}
