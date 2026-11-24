export type WorkspaceRole = 'admin' | 'member' | 'viewer';

export interface WorkspaceMembership {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
}

export function canEditWorkspace(role: WorkspaceRole): boolean {
  return role === 'member' || role === 'admin';
}
