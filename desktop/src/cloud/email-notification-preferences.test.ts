import {afterEach, expect, it, vi} from 'vitest';
import {readEmailNotification, setEmailNotification, subscribeEmailNotifications} from './email-notification-preferences';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it('sends nothing until someone asks for it', () => {
  // Mail leaves only on an explicit choice: nobody receives what they never
  // turned on, and a fresh workspace stays quiet.
  for (const name of ['always', 'activity', 'pageUpdates', 'digest'] as const) {
    expect(readEmailNotification(name), name).toBe(false);
  }
});

it('remembers a choice for the next launch and tells its readers at once', () => {
  const notified = vi.fn();
  const stop = subscribeEmailNotifications(notified);
  try {
    setEmailNotification('activity', false);
    expect(readEmailNotification('activity')).toBe(false);
    expect(notified).toHaveBeenCalledTimes(1);
    setEmailNotification('always', true);
    expect(readEmailNotification('always')).toBe(true);
    expect(localStorage.getItem('blok:desktop:email-activity:v1')).toBe('false');
  } finally { stop(); }
});

it('follows a change made in another window', () => {
  const notified = vi.fn();
  const stop = subscribeEmailNotifications(notified);
  try {
    const key = 'blok:desktop:email-digest:v1';
    localStorage.setItem(key, 'false');
    window.dispatchEvent(new StorageEvent('storage', {key, newValue: 'false'}));
    expect(notified).toHaveBeenCalled();
    expect(readEmailNotification('digest')).toBe(false);
  } finally { stop(); }
});

it('keeps the choice for this session when the device refuses to store it', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  setEmailNotification('pageUpdates', false);
  expect(readEmailNotification('pageUpdates')).toBe(false);
});
