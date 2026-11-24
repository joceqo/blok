import { isReaderRole } from './access-vocabulary';
import type { WorkspaceRef } from './workspace-registry';

/** Ce que le serveur accorde sur une page précise. */
export type PageLevel = 'view' | 'comment' | 'edit' | 'full';
export interface PageAccessEntry {
  level: PageLevel;
  teamspaceId?: string | null;
  publicId?: string;
  /** Visibilité effective, héritée comprise : ce qui range la page dans sa section. */
  visibility?: 'inherit' | 'private' | 'workspace';
  /** Quelqu'un d'autre que moi a un droit sur cette page ou l'un de ses ancêtres. */
  shared?: boolean;
  /** Son parent réel est hors d'atteinte : elle s'affiche détachée. */
  sharedRoot?: boolean;
  sharedWithMe?: boolean;
}
export type PageAccessMap = Record<string, PageAccessEntry>;

export interface PageAccess {
  /** L'espace entier est en lecture seule : le compte, pas la page. */
  readonly readOnlyWorkspace: boolean;
  canComment(pageId: string): boolean;
  canEdit(pageId: string): boolean;
  canShare(pageId: string): boolean;
  isSharedRoot(pageId: string): boolean;
}

const rank: Record<PageLevel, number> = { view: 1, comment: 2, edit: 3, full: 4 };

/**
 * L'interface ne savait dire qu'une chose : cet espace est-il en lecture seule ?
 * Elle doit dire : cette page-ci l'est-elle ? Un seul point de décision, consulté
 * partout, plutôt qu'un booléen calculé une fois à l'ouverture.
 *
 * Une page dont le niveau n'est pas connu se ferme. L'inverse ouvrirait un
 * éditeur modifiable sur une page refusée côté serveur, et l'utilisateur perdrait
 * sa frappe au premier enregistrement.
 */
export function pageAccess(ref: WorkspaceRef, reported: PageAccessMap | undefined): PageAccess {
  if (ref.kind !== 'remote') {
    return { readOnlyWorkspace: false, canComment: () => true, canEdit: () => true, canShare: () => false, isSharedRoot: () => false };
  }
  const readOnlyWorkspace = isReaderRole(ref.role);
  // Un serveur antérieur aux permissions par page n'annonce aucun niveau. Le
  // rôle d'espace reste alors la seule réponse disponible, et c'est exactement
  // le comportement qu'il avait avant.
  const roleLevel: Record<string, PageLevel> = { viewer: 'view', member: 'edit', admin: 'full' };
  const fallback: PageLevel = roleLevel[ref.role ?? 'member'] ?? 'edit';
  const levelOf = (pageId: string): PageLevel | null => {
    if (!reported) return pageId && ref.role !== 'guest' ? fallback : null;
    return reported[pageId]?.level ?? null;
  };
  const atLeast = (pageId: string, needed: PageLevel): boolean => {
    const level = levelOf(pageId);
    if (level === null) return false;
    // A viewer can post only on an explicit comment grant reported by the server.
    if (readOnlyWorkspace && needed !== 'view') return needed === 'comment' && level === 'comment';
    return rank[level] >= rank[needed];
  };
  return {
    readOnlyWorkspace,
    canComment: (pageId) => atLeast(pageId, 'comment'),
    canEdit: (pageId) => atLeast(pageId, 'edit'),
    canShare: (pageId) => atLeast(pageId, 'full'),
    isSharedRoot: (pageId) => reported?.[pageId]?.sharedRoot === true,
  };
}
