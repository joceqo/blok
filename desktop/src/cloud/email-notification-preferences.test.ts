import {afterEach, expect, it, vi} from 'vitest';
import {loadEmailNotifications, readEmailNotification, resetEmailNotifications, setEmailNotification, subscribeEmailNotifications} from './email-notification-preferences';

afterEach(() => {
  resetEmailNotifications();
  vi.restoreAllMocks();
});

const clientWith = (response: unknown) => ({request: vi.fn().mockResolvedValue(response)});

it('sends nothing until the workspace says someone asked', () => {
  // Nothing loaded yet: the reader must not invent a yes.
  for (const name of ['always', 'activity', 'pageUpdates', 'digest'] as const) {
    expect(readEmailNotification(name), name).toBe(false);
  }
});

it('takes its answer from the workspace, not from this device', async () => {
  const client = clientWith({activity: true, always: false, pageUpdates: true, digest: false});
  const notified = vi.fn();
  const stop = subscribeEmailNotifications(notified);
  try {
    await loadEmailNotifications({client, slug: 'acme'});
    expect(client.request).toHaveBeenCalledWith('/api/workspaces/acme/email-preferences', expect.anything());
    expect(readEmailNotification('activity')).toBe(true);
    expect(readEmailNotification('pageUpdates')).toBe(true);
    expect(readEmailNotification('digest')).toBe(false);
    expect(notified).toHaveBeenCalled();
  } finally { stop(); }
});

it('shows the choice at once and writes it to the workspace', async () => {
  const client = clientWith({activity: true, always: false, pageUpdates: false, digest: false});
  await loadEmailNotifications({client, slug: 'acme'});
  client.request.mockClear();
  setEmailNotification('digest', true);
  expect(readEmailNotification('digest')).toBe(true);
  await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
    '/api/workspaces/acme/email-preferences',
    expect.objectContaining({method: 'PUT', body: JSON.stringify({digest: true})}),
  ));
});

it('puts the switch back when the workspace refuses the change', async () => {
  const client = clientWith({activity: false, always: false, pageUpdates: false, digest: false});
  await loadEmailNotifications({client, slug: 'acme'});
  client.request.mockRejectedValue(new Error('offline'));
  setEmailNotification('activity', true);
  expect(readEmailNotification('activity')).toBe(true);
  // A switch that stays on after a failed write promises mail nobody will send.
  await vi.waitFor(() => expect(readEmailNotification('activity')).toBe(false));
});
