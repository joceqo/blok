export interface PageTreeRow {
  id: string;
  title: string;
  parentId: string | null;
  trashed: boolean;
  updatedAt: Date;
}

export interface PageTreeNode {
  id: string;
  title: string;
  parentId: string | null;
  trashed: boolean;
  updatedAt: Date;
  children: PageTreeNode[];
}

const DEFAULT_MAX_DEPTH = 64;

function compareByTitle(a: PageTreeRow, b: PageTreeRow): number {
  return a.title.localeCompare(b.title);
}

/** Build a forest of page trees from flat workspace rows (non-trashed callers filter upstream). */
export function buildPagesTree(rows: PageTreeRow[]): PageTreeNode[] {
  const byId = new Map<string, PageTreeRow>();
  for (const row of rows) {
    byId.set(row.id, row);
  }

  const childrenByParent = new Map<string | null, PageTreeRow[]>();
  const pushChild = (parentKey: string | null, row: PageTreeRow): void => {
    const bucket = childrenByParent.get(parentKey);
    if (bucket === undefined) {
      childrenByParent.set(parentKey, [row]);
      return;
    }
    bucket.push(row);
  };

  for (const row of rows) {
    const parentKey =
      row.parentId !== null && byId.has(row.parentId) ? row.parentId : null;
    pushChild(parentKey, row);
  }

  for (const bucket of childrenByParent.values()) {
    bucket.sort(compareByTitle);
  }

  const buildNode = (row: PageTreeRow): PageTreeNode => {
    const kids = childrenByParent.get(row.id) ?? [];
    return {
      id: row.id,
      title: row.title,
      parentId: row.parentId,
      trashed: row.trashed,
      updatedAt: row.updatedAt,
      children: kids.map(buildNode),
    };
  };

  const roots = childrenByParent.get(null) ?? [];
  return roots.map(buildNode);
}

/** All descendant page ids under `pageId`, bounded by depth and cycle safety. */
export function collectDescendantIds(
  pageId: string,
  rows: Pick<PageTreeRow, 'id' | 'parentId'>[],
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parentId === null) {
      continue;
    }
    const list = childrenByParent.get(row.parentId);
    if (list === undefined) {
      childrenByParent.set(row.parentId, [row.id]);
    } else {
      list.push(row.id);
    }
  }

  const out = new Set<string>();
  let frontier = childrenByParent.get(pageId) ?? [];
  let depth = 0;

  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const id of frontier) {
      if (out.has(id)) {
        continue;
      }
      out.add(id);
      const kids = childrenByParent.get(id);
      if (kids !== undefined) {
        next.push(...kids);
      }
    }
    frontier = next;
    depth += 1;
  }

  return out;
}

export function wouldCreatePageCycle(
  pageId: string,
  newParentId: string | null,
  rows: Pick<PageTreeRow, 'id' | 'parentId'>[],
): boolean {
  if (newParentId === null) {
    return false;
  }
  if (newParentId === pageId) {
    return true;
  }
  return collectDescendantIds(pageId, rows).has(newParentId);
}