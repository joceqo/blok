import { canEditPage } from './page-level.js';
import type { IndexPage, Role } from './workspace-index.js';
import { workspaceIndex } from './workspace-index.js';

type Page = Record<string, unknown> & { id: string; title: string; parentId?: string | null };
type Incoming = { meta: Page; trashed: boolean };
export interface SaveIndex { revision: number; incoming: Incoming[] }

export class IndexError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, message: string) { super(message); }
}

const pageId = /^[A-Za-z0-9_-]{1,128}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const shortText = (value: unknown, limit: number): boolean =>
  typeof value === 'string' && Buffer.byteLength(value) <= limit;

function validPage(p: unknown): p is Page {
  if (!record(p) || typeof p.id !== 'string' || !pageId.test(p.id) || !shortText(p.title, 4096)) return false;
  if (p.parentId != null && (typeof p.parentId !== 'string' || !pageId.test(p.parentId))) return false;
  if (['icon','cover','titleDate','titleDateSuffix'].some(key => p[key] != null && !shortText(p[key], 4096))) return false;
  if (['favorite','fullWidth'].some(key => p[key] != null && typeof p[key] !== 'boolean')) return false;
  if (p.coverPosition != null && !Number.isFinite(p.coverPosition)) return false;
  if (p.titleDateDisplay == null) return true;
  const display = p.titleDateDisplay;
  if (!record(display) || ['dateFormat', 'timeFormat', 'timeZone', 'defaultReminder'].some(
    key => display[key] != null && !shortText(display[key], 128),
  )) return false;
  if (typeof display.timeZone !== 'string') return true;
  if (!display.timeZone || display.timeZone === 'Local' || /^[+-]/.test(display.timeZone)) return false;
  try { Intl.DateTimeFormat('en', { timeZone: display.timeZone }); return true; } catch { return false; }
}

function checkTree(parents: Map<string, string | null>, allowMissing: boolean) {
  // One visit per page, including on a 10,000-page chain.
  const done = new Set<string>();
  for (const start of parents.keys()) {
    const chain = new Set<string>();
    let node: string | null = start;
    while (node !== null && !done.has(node)) {
      if (chain.has(node) || (!allowMissing && !parents.has(node))) {
        throw new IndexError(400, 'Invalid parent hierarchy (missing parent or cycle)');
      }
      chain.add(node);
      node = parents.get(node) ?? null;
    }
    for (const id of chain) done.add(id);
  }
}

export function parseIndex(body: unknown): SaveIndex {
  if (!record(body) || typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision)
    || !Array.isArray(body.pages) || (body.trash != null && !Array.isArray(body.trash))
    || body.pages.length + (body.trash?.length ?? 0) > 10000) {
    throw new IndexError(400, 'Pages and revision required');
  }
  const incoming: Incoming[] = [];
  const parents = new Map<string, string | null>();
  for (const [pages, trashed] of [[body.pages, false], [body.trash ?? [], true]] as const) {
    for (const meta of pages) {
      if (!validPage(meta) || parents.has(meta.id)) throw new IndexError(400, 'Invalid page metadata');
      incoming.push({ meta, trashed });
      parents.set(meta.id, meta.parentId ?? null);
    }
  }
  checkTree(parents, false);
  return { revision: body.revision, incoming };
}

export function planIndexSave(current: IndexPage[], role: Role, incoming: Incoming[]) {
  const { access } = workspaceIndex(current, role, 0);
  const byId = new Map(current.map(row => [row.id, row]));
  const writable = (id: string) => canEditPage(access[id]?.level);
  const sent = new Set(incoming.map(entry => entry.meta.id));
  const removed = current.filter(row => writable(row.id) && !sent.has(row.id)).map(row => row.id);
  const behind = new Map<string, string[]>();
  let anchor = '';
  // Keep invisible and read-only pages behind their preceding writable page.
  for (const row of current) {
    if (writable(row.id)) { anchor = row.id; continue; }
    const group = behind.get(anchor) ?? [];
    group.push(row.id);
    behind.set(anchor, group);
  }
  const fixed: {id: string; position: number}[] = [];
  const updates: {id: string; metadata: Page; trashed: boolean}[] = [];
  const creations: {id: string; metadata: Page; trashed: boolean; visibility: string}[] = [];
  let position = 0;
  const appendFixed = (ids: string[]) => {
    for (const id of ids) fixed.push({id, position: position++});
  };
  const finalParents = new Map(current.map(row => [row.id, row.metadata.parentId ?? null]));
  for (const id of removed) finalParents.delete(id);
  appendFixed(behind.get('') ?? []);
  behind.delete('');
  for (const { meta, trashed } of incoming) {
    const prior = byId.get(meta.id);
    if (prior && !access[meta.id]) throw new IndexError(403, 'Page access refused');
    const previousParent = prior?.metadata.parentId ?? null;
    // A visible shared root is detached by GET when its real parent is hidden.
    const effectiveParent = meta.parentId ?? (previousParent && !access[previousParent] ? previousParent : null);
    if (previousParent !== effectiveParent) {
      if ((prior && !writable(meta.id)) || (effectiveParent && byId.has(effectiveParent) && !writable(effectiveParent))) {
        throw new IndexError(403, 'Write access to source and destination required');
      }
    }
    if (!prior || writable(meta.id)) {
      const metadata: Page = { ...meta, position: position++ };
      if (effectiveParent) metadata.parentId = effectiveParent;
      let visibility = metadata.parentId ? 'inherit' : 'workspace';
      if (Object.hasOwn(metadata, 'initialVisibility')) {
        if (metadata.initialVisibility !== 'private') throw new IndexError(400, 'Invalid initial visibility');
        if (!prior && metadata.parentId) throw new IndexError(400, 'Private creation requires a root page');
        if (!prior) visibility = 'private';
        delete metadata.initialVisibility;
      }
      finalParents.set(meta.id, metadata.parentId ?? null);
      const row = { id: meta.id, metadata, trashed };
      if (prior) updates.push(row);
      else creations.push({ ...row, visibility });
    }
    appendFixed(behind.get(meta.id) ?? []);
    behind.delete(meta.id);
  }
  for (const leftover of behind.values()) appendFixed(leftover);
  // A detached, shared root can hide an ancestor from the submitted tree.
  // Validate restored parent links too before making a move persistent.
  checkTree(finalParents, true);
  return { fixed, updates, creations, removed };
}
