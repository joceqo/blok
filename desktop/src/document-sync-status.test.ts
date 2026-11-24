import { describe, expect, it } from 'vitest';
import type { CollaborationStatusChangedPayload } from '@bloklabs/core/full';
import { documentSyncStatus } from './document-sync-status';

type Save = NonNullable<CollaborationStatusChangedPayload['save']>;
const save = (state: Save['state']): Save => ({
  state, pendingOperations: 0, pendingBytes: 0, quarantinedOperations: 0,
});

describe('document sync status', () => {
  it('requires both an acknowledged document and an empty metadata queue', () => {
    const event = { status: 'connected' as const, save: save('saved') };
    expect(documentSyncStatus(event, true).state).toBe('pending');
    expect(documentSyncStatus(event, false).state).toBe('connected');
    expect(documentSyncStatus({ status: 'connected' }, false).state).toBe('unconfirmed');
    expect(documentSyncStatus({ status: 'connected', save: save('unavailable') }, false).state).toBe('unconfirmed');
  });
  it('shows pending, failed and quarantined writes even with zero readable operations', () => {
    expect(documentSyncStatus({ status: 'connected', save: save('pending') }, false).state).toBe('pending');
    for (const state of ['blocked', 'quarantined'] as const) {
      expect(documentSyncStatus({ status: 'connected', save: save(state) }, false)).toMatchObject({
        state: 'error', message: expect.stringContaining('Copiez'),
      });
    }
  });
  it('distinguishes an offline queue, a reconnect and a revoked session', () => {
    expect(documentSyncStatus({ status: 'offline', save: save('pending') }, false).message).toContain('Gardez');
    expect(documentSyncStatus({ status: 'offline', save: save('saved') }, false).message).toContain('Reconnexion');
    expect(documentSyncStatus({ status: 'connecting' }, false).state).toBe('connecting');
    expect(documentSyncStatus({ status: 'error', error: 'forbidden' }, false).state).toBe('denied');
    expect(documentSyncStatus({ status: 'error', error: 'apply-failed' }, false).state).toBe('error');
    expect(documentSyncStatus(undefined, false).state).toBe('connecting');
  });
});
