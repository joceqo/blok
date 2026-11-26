import { peekFile } from './storage';
import { initialWorkspace, listWorkspaces, type LocalWorkspace } from './workspace-registry';

/** Resolve the named disk manifest before changing workspace or mounting its editor. */
export async function diskPageWorkspace(workspaceId: string, pageId: string): Promise<LocalWorkspace> {
  const ref = workspaceId === initialWorkspace.id ? initialWorkspace :
    listWorkspaces().find((item): item is LocalWorkspace => item.kind === 'local' && item.id === workspaceId);
  if (!ref) throw new Error('Espace sur disque introuvable sur cet appareil.');
  const raw = await peekFile('index', ref);
  const index = raw && JSON.parse(raw);
  if (!Array.isArray(index?.pages) || !index.pages.some((page: {id?: unknown} | null) => page?.id === pageId)) {
    throw new Error('Page introuvable dans cet espace sur disque.');
  }
  return ref;
}
