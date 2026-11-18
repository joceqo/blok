import type { API, BlockAPI } from '../../types';

export interface RowRouteStep { row: BlockAPI; database: BlockAPI }

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
export async function openRowRoute(blocks: API['blocks'], row: BlockAPI, database: BlockAPI, signal: AbortSignal): Promise<RowRouteStep[]> {
  const path = rowRoutePath(blocks, row, database);
  for (let index = 0; index < path.length; index++) {
    if (signal.aborted) return [];
    const step = path[index];
    step.database.call('openRow', { rowId: step.row.id, mode: 'full', explicit: true });
    if (index < path.length - 1 && !await waitForBody(step.row, signal)) return [];
  }
  return signal.aborted ? [] : path;
}
