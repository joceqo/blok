/** JSON wire shape for a workspace audit_events row. */
export function serializeAuditEvent(row: {
  id: string;
  workspaceId: string | null;
  userId: string;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}): {
  id: string;
  workspaceId: string | null;
  userId: string;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
} {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    action: row.action,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}