import { planRowBody } from './row-body-plan';
import type { OutputBlockData, OutputData } from '../../types';

/**
 * Moving the bodies of a local page's rows into documents of their own.
 *
 * The server does this offline (`blokctl rows migrate`) because it owns the
 * document and nobody is editing it at that moment. A local workspace has the
 * same requirement for the same reason, so this runs while the page is being
 * LOADED — before any editor holds it — and hands back the rewritten document
 * for that load to continue with.
 *
 * The eligibility rules are the server's (`row_bodies_migration.go`): a row is
 * skipped rather than half-moved whenever the move would be ambiguous.
 */

export interface RowBodyWrite {
  bodyId: string;
  rowId: string;
  databaseId: string;
  title: string;
  icon?: string;
  body: OutputData;
}

export interface RowBodyMigration {
  /** The page as it should now be stored, rows naming their bodies. */
  source: OutputData;
  /** The body documents to write, in order. Empty when nothing moved. */
  writes: RowBodyWrite[];
  /** Rows left alone, with the reason — the server's vocabulary. */
  skipped: Array<{ rowId: string; reason: 'nested-row' | 'existing-page' | 'template' | 'legacy-body' | 'nested-database' | 'empty' }>;
}

type Block = OutputBlockData & { id?: string; type?: string; parent?: string; content?: string[]; data?: Record<string, unknown> };

const descendants = (byId: Map<string, Block>, rootIds: string[]): Block[] => {
  const out: Block[] = [];
  const stack = [...rootIds];

  while (stack.length > 0) {
    const block = byId.get(String(stack.pop()));

    if (block === undefined) continue;
    out.push(block);
    stack.push(...(block.content ?? []));
  }

  return out;
};

/** A body still living in a richText property must be converted first, not moved. */
const hasLegacyBody = (row: Block): boolean =>
  row.data?.bodyBlocks !== true
  && Object.values((row.data?.properties ?? {}) as Record<string, unknown>).some((value) => {
    const blocks = (value as { blocks?: unknown } | null)?.blocks;

    return Array.isArray(blocks) && blocks.length > 0;
  });

/**
 * @param document - the page as read from its file; never modified
 * @param mintId - how a body document gets its id
 */
export const planRowBodyMigration = (document: OutputData, mintId: () => string): RowBodyMigration => {
  const state = { source: document };
  const writes: RowBodyWrite[] = [];
  const skipped: RowBodyMigration['skipped'] = [];
  const byId = new Map((document.blocks as Block[]).map((block) => [String(block.id), block]));
  const rows = (document.blocks as Block[]).filter((block) => block.type === 'database-row');

  for (const row of rows) {
    const rowId = String(row.id);
    const parent = byId.get(String(row.parent));
    const roots = (row.content ?? []).filter((child) => byId.get(child)?.type !== 'database-comment');
    const moving = descendants(byId, roots);
    const reason = ((): RowBodyMigration['skipped'][number]['reason'] | null => {
      if (parent?.type !== 'database') return 'nested-row';
      if (row.data?.pageId !== undefined && row.data.pageId !== null) return 'existing-page';
      if (row.data?.template === true) return 'template';
      if (hasLegacyBody(row)) return 'legacy-body';
      if (moving.some((block) => block.type === 'database' || block.type === 'database-row')) return 'nested-database';
      if (roots.length === 0) return 'empty';

      return null;
    })();

    if (reason !== null) {
      skipped.push({ rowId, reason });
      continue;
    }

    const bodyId = mintId();
    const plan = planRowBody(state.source, rowId, bodyId);

    state.source = plan.source;
    writes.push({
      bodyId, rowId,
      databaseId: String(row.parent),
      title: typeof row.data?.title === 'string' && row.data.title.trim() ? row.data.title.trim() : 'Ligne',
      ...(typeof row.data?.icon === 'string' ? { icon: row.data.icon } : {}),
      body: plan.body,
    });
  }

  return { source: state.source, writes, skipped };
};
