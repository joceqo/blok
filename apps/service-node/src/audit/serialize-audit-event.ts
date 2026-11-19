function auditMetadata(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** JSON wire shape for a workspace audit_events row. */
export function serializeAuditEvent(row: {
  id: string;
  workspaceId: string | null;
  userId: string;
  action: string;
  metadata: unknown;
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
    metadata: auditMetadata(row.metadata),
    createdAt: row.createdAt,
  };
}