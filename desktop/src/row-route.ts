import type { API, BlockAPI } from '../../types';

export interface RowRouteStep { row: BlockAPI; database: BlockAPI; documentId?: string }
export interface RowLocationStep { documentId: string; rowId: string; databaseId?: string }
interface MountedRowEditor { isReady: Promise<unknown>; blocks?: API['blocks'] }

/** Follow block ownership, not the DOM (closed row bodies are pooled/hidden). */
export function rowRoutePath(blocks: Pick<API['blocks'], 'getById'>, row: BlockAPI, database: BlockAPI): RowRouteStep[] {
  const path = [{ row, database }];
  const seen = new Set([row.id]);
  let block: BlockAPI | undefined = database;
  while (block) {
    if (seen.has(block.id)) throw new Error('Cycle dans le chemin de la page.');
    seen.add(block.id);
    if (block.name === 'database-row') {
      const owner = block.parentId ? blocks.getById(block.parentId) : undefined;
      if (!owner || owner.name !== 'database') throw new Error('Page parente indisponible.');
      path.unshift({ row: block, database: owner });
    }
    if (!block.parentId) break;
    const parent = blocks.getById(block.parentId);
    if (!parent) throw new Error('Page parente indisponible.');
    block = parent;
  }
  return path;
}

/** Ancestor bodies attach after paint; never open the next drawer in their pool. */
function waitForBody(row: BlockAPI, signal: AbortSignal): Promise<boolean> {
  const attached = (): boolean => row.holder.isConnected && row.holder.parentElement?.hasAttribute('data-blok-database-drawer-editor') === true;
  if (signal.aborted || attached()) return Promise.resolve(!signal.aborted);
  return new Promise((resolve, reject) => {
    const finish = (ready: boolean, error?: Error): void => {
      observer.disconnect(); clearTimeout(timeout); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(ready);
    };
    const abort = (): void => finish(false);
    const observer = new MutationObserver(() => { if (attached()) finish(true); });
    const timeout = setTimeout(() => finish(false, new Error('Le corps de la page parente ne s’est pas ouvert.')), 10000);
    observer.observe(row.holder.ownerDocument.body, { childList: true, subtree: true });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else if (attached()) finish(true);
  });
}

/** Present a resolved row through the same entry point on load and navigation. */
export async function openRowRoute(blocks: API['blocks'], row: BlockAPI, database: BlockAPI, signal: AbortSignal, onOpen?: (step: RowRouteStep) => void): Promise<RowRouteStep[]> {
  const path = rowRoutePath(blocks, row, database);
  for (let index = 0; index < path.length; index++) {
    if (signal.aborted) return [];
    const step = path[index];
    step.database.call('openRow', { rowId: step.row.id, mode: 'full', explicit: true });
    onOpen?.(step);
    if (index < path.length - 1 && !await waitForBody(step.row, signal)) return [];
  }
  return signal.aborted ? [] : path;
}

/** Wait for the actual mounted editor; a speculative/parked body is not a route. */
function waitForMountedEditor(
  documentId: string,
  lookup: (documentId: string) => MountedRowEditor | undefined,
  signal: AbortSignal,
): Promise<MountedRowEditor | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const state = {done:false, timer:undefined as ReturnType<typeof setTimeout> | undefined, editor:undefined as MountedRowEditor | undefined, ready:false};
    const finish = (editor: MountedRowEditor | null, error?: unknown): void => {
      if (state.done) return;
      state.done=true;
      clearTimeout(state.timer); clearTimeout(deadline); signal.removeEventListener('abort', abort);
      if (error !== undefined) reject(error); else resolve(editor);
    };
    const abort = (): void => finish(null);
    const deadline = setTimeout(() => finish(null, new Error('Le corps de la page parente ne s’est pas ouvert.')), 10000);
    const poll = (): void => {
      if (state.done) return;
      if (signal.aborted) { finish(null); return; }
      const current = {editor:undefined as MountedRowEditor | undefined};
      try { current.editor=lookup(documentId); } catch (error) { finish(null,error); return; }
      const editor=current.editor;
      if (editor !== state.editor) {
        state.editor=editor; state.ready=false;
        if (editor) void editor.isReady.then(() => {
          if (!state.done && state.editor === editor) {
            state.ready=true;
            if (lookup(documentId) === editor) finish(editor);
          }
        }).catch(error => { if (state.editor === editor) finish(null,error); });
      }
      if (editor && state.ready) { finish(editor); return; }
      state.timer=setTimeout(poll,16);
    };
    signal.addEventListener('abort',abort,{once:true});
    poll();
  });
}

async function rowLocationBlocks(
  documentId: string, rootDocumentId: string, rootBlocks: API['blocks'],
  parent: BlockAPI | undefined, getMountedEditor: (documentId: string) => MountedRowEditor | undefined,
  signal: AbortSignal,
): Promise<API['blocks'] | null> {
  if (!parent) {
    if (documentId !== rootDocumentId) throw new Error('Page parente indisponible.');
    return rootBlocks;
  }
  const values: Array<{pageId?: string}> = [];
  parent.call('readData', {receive: (data: {pageId?: string}) => values.push(data)});
  if ((values[0] ?? parent.preservedData)?.pageId !== documentId) throw new Error('Page parente indisponible.');
  const editor = await waitForMountedEditor(documentId, getMountedEditor, signal);
  if (!editor || signal.aborted) return null;
  if (!editor.blocks) throw new Error('Page parente indisponible.');
  return editor.blocks;
}

function checkRequestedRowPath(actual: RowRouteStep[], requested: RowLocationStep[]): void {
  const cursor = {index: 0};
  for (const target of requested) {
    const found = actual.findIndex((step, index) => index >= cursor.index && step.row.id === target.rowId && (target.databaseId === undefined || step.database.id === target.databaseId));
    if (found < 0) throw new Error('Page parente indisponible.');
    cursor.index = found + 1;
  }
}

/** Resolve each document boundary through its owning row before opening a descendant. */
export async function openRowLocation(
  rootDocumentId: string,
  rootBlocks: API['blocks'],
  steps: RowLocationStep[],
  getMountedEditor: (documentId: string) => MountedRowEditor | undefined,
  signal: AbortSignal,
  onProgress?: (steps: RowRouteStep[]) => void,
): Promise<RowRouteStep[]> {
  const opened: RowRouteStep[]=[];
  const visited = new Set<string>();
  const state = {index:0};
  while (state.index < steps.length) {
    if (signal.aborted) return [];
    const first=steps[state.index];
    if (!first || visited.has(first.documentId)) throw new Error('Cycle dans le chemin de la page.');
    visited.add(first.documentId);
    const blocks = await rowLocationBlocks(first.documentId, rootDocumentId, rootBlocks, opened.at(-1)?.row, getMountedEditor, signal);
    if (!blocks || signal.aborted) return [];
    const groupStart = state.index;
    while (steps[state.index]?.documentId === first.documentId) state.index++;
    const group = steps.slice(groupStart, state.index);
    const target=group.at(-1);
    const row=target ? blocks.getById(target.rowId) : undefined;
    const databaseId=target?.databaseId ?? row?.parentId;
    const database=databaseId ? blocks.getById(databaseId) : undefined;
    if (!row || row.name !== 'database-row' || !database || database.name !== 'database' || row.parentId !== database.id) throw new Error('Page parente indisponible.');
    const actual=rowRoutePath(blocks,row,database);
    checkRequestedRowPath(actual, group);
    await openRowRoute(blocks,row,database,signal,step=>{
      opened.push({...step,documentId:first.documentId});
      onProgress?.([...opened]);
    });
    if (signal.aborted) return [];
  }
  return opened;
}
