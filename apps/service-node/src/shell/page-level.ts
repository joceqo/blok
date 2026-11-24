export const levels = ['view', 'edit', 'full'] as const;
export type Level = typeof levels[number];
export type Role = 'admin' | 'member' | 'viewer';
export type Visibility = 'private' | 'workspace';

export function resolvePageLevel(role: Role, visibility: Visibility, highestShareIndex: number): Level | undefined {
  const workspaceBase = { admin: 2, member: 1, viewer: 0 };
  const base = visibility === 'workspace' ? workspaceBase[role] : -1;
  const ceiling = role === 'viewer' ? 0 : 2;
  return levels[Math.min(ceiling, Math.max(base, highestShareIndex))];
}
