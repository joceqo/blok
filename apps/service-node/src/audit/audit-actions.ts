/** Known workspace audit kinds — stored `action` strings come from {@link formatAuditAction}. */
export type AuditActionInput =
  | { kind: 'workspace_delete' }
  | { kind: 'workspace_transfer_ownership' };

export function formatAuditAction(input: AuditActionInput): string {
  switch (input.kind) {
    case 'workspace_delete':
      return 'workspace.delete';
    case 'workspace_transfer_ownership':
      return 'workspace.transfer_ownership';
  }
}