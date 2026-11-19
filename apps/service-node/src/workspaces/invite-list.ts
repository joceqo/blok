/** Rows returned for workspace-scoped invite listings (pending only in API). */
export type WorkspaceInviteListRow = {
  id: string;
  workspaceId: string;
  email: string;
  role: string;
  invitedBy: string;
  createdAt: Date;
  acceptedAt: Date | null;
};

export function isPendingWorkspaceInvite(row: { acceptedAt: Date | null }): boolean {
  return row.acceptedAt === null;
}

export function filterPendingWorkspaceInvites<T extends { acceptedAt: Date | null }>(rows: T[]): T[] {
  return rows.filter(isPendingWorkspaceInvite);
}