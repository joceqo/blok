import type { ShellPage } from '@blok/sidebar';
import type { PageAccess } from './page-access';

export class PageMoveConflict extends Error {
  constructor() {
    super('Le déplacement a été refusé. Rouvrez « Déplacer vers » pour choisir une destination à jour.');
  }
}

/** Only live pages are passed here. Current parent, source and its whole subtree are excluded. */
export function moveDestinations(pages: ShellPage[], sourceId: string, access: PageAccess): Set<string | null> {
  const destinations = new Set<string | null>();
  const source = pages.find((page) => page.id === sourceId);
  if (!source || !access.canEdit(sourceId)) return destinations;
  const children = new Map<string, string[]>();
  for (const page of pages) {
    if (page.parentId === null) continue;
    const list = children.get(page.parentId) ?? [];
    list.push(page.id);
    children.set(page.parentId, list);
  }
  const excluded = new Set<string>([sourceId]);
  for (const id of excluded) for (const child of children.get(id) ?? []) excluded.add(child);
  if (source.parentId !== null && !access.readOnlyWorkspace) destinations.add(null);
  for (const page of pages) {
    if (!excluded.has(page.id) && source.parentId !== page.id && access.canEdit(page.id)) destinations.add(page.id);
  }
  return destinations;
}
