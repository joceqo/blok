import type { WorkspaceRole } from '../models/Workspace.ts';

export const levels = ['view', 'edit', 'full'] as const;
export type Level = typeof levels[number];
export type Role = WorkspaceRole;
export type Visibility = 'private' | 'workspace';

export function resolvePageLevel(role: Role, visibility: Visibility, highestShareIndex: number): Level | undefined {
  const workspaceBase = { admin: 2, member: 1, viewer: 0 };
  const base = visibility === 'workspace' ? workspaceBase[role] : -1;
  const ceiling = role === 'viewer' ? 0 : 2;
  return levels[Math.min(ceiling, Math.max(base, highestShareIndex))];
}

export function canEditPage(level: Level | undefined): boolean {
  return level === 'edit' || level === 'full';
}
