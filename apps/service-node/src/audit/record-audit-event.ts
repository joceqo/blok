import type { Database } from '../db/index.ts';
import { auditEvents } from '../db/schema.ts';

import { formatAuditAction, type AuditActionInput } from './audit-actions.ts';

type DbExecutor = Pick<Database, 'insert'>;

export type RecordAuditEventInput = {
  userId: string;
  workspaceId: string | null;
  action: AuditActionInput;
  metadata?: Record<string, unknown>;
};

export async function recordAuditEvent(
  db: DbExecutor,
  input: RecordAuditEventInput,
): Promise<void> {
  await db.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    action: formatAuditAction(input.action),
    metadata: input.metadata ?? {},
  });
}