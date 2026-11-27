import type { ShellPage } from '@blok/sidebar';

export function groupPages<K>(
  pages: ShellPage[],
  keyFor: (page: ShellPage) => K,
): Map<K, ShellPage[]> {
  const groups = new Map<K, ShellPage[]>();
  for (const page of pages) {
    const key = keyFor(page);
    const group = groups.get(key);
    if (group) group.push(page);
    else groups.set(key, [page]);
  }
  return groups;
}

/** Iterating the growing set visits each parent once, including shared ancestors. */
export function withAncestors(ids: string[], pages: ShellPage[]): Set<string> {
  const parents = new Map(pages.map((page) => [page.id, page.parentId]));
  const visible = new Set(ids);
  for (const id of visible) {
    const parent = parents.get(id);
    if (parent) visible.add(parent);
  }
  return visible;
}
