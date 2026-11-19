import type { Database } from '@/db/index.js';
import { auditEvents } from '@/db/schema.js';

import { formatAuditAction, type AuditActionInput } from './audit-actions.js';

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