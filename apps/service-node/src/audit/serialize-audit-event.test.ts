import { describe, expect, it } from 'vitest';

import { serializeAuditEvent } from '@/audit/serialize-audit-event.js';

describe('serializeAuditEvent', () => {
  it('maps an audit_events row to the list API wire shape', () => {
    const createdAt = new Date('2026-03-01T12:00:00.000Z');
    expect(
      serializeAuditEvent({
        id: 'evt-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        action: 'workspace.delete',
        metadata: { targetUserId: 'user-2' },
        createdAt,
      }),
    ).toEqual({
      id: 'evt-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      action: 'workspace.delete',
      metadata: { targetUserId: 'user-2' },
      createdAt,
    });
  });
});