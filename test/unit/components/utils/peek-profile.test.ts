import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bindPeekProfile, measurePeek, peekProfileFor, startPeekProfile } from '../../../../src/components/utils/peek-profile';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  history.replaceState(null, '', '/?profile=1');
  vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
  vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
  vi.spyOn(console, 'table').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

it('does not schedule diagnostics without opt-in and preserves callback results', () => {
  history.replaceState(null, '', '/');
  const timers = vi.getTimerCount();
  const profile = startPeekProfile('side');
  expect(profile).toBeUndefined();
  expect(vi.getTimerCount()).toBe(timers);
  expect(measurePeek(profile, 'focus', () => 42)).toBe(42);
});

it('separates synchronous spans, paint opportunity and actual loading milestones', () => {
  const profile = startPeekProfile('side');
  const error = new Error('failure');
  expect(() => measurePeek(profile, 'focus', () => { vi.advanceTimersByTime(30); throw error; })).toThrow(error);
  expect(profile?.record.spans[0]).toMatchObject({ name: 'focus', durationMs: 30 });
  profile?.mark('editorReady');
  expect(profile?.record.milestones.contentInteractive).toBeUndefined();
  vi.advanceTimersToNextFrame();
  vi.advanceTimersByTime(1);
  expect(profile?.record.milestones.shellPaintOpportunity).toBeDefined();
  profile?.finish('closed');
  const snapshot = JSON.stringify(profile?.record);
  profile?.mark('latePromise');
  expect(JSON.stringify(profile?.record)).toBe(snapshot);
});

it('finds the nearest body profile and stops retaining an active association after close', () => {
  const profile = startPeekProfile('center');
  const holder = document.createElement('div');
  const child = document.createElement('div');
  holder.append(child);
  bindPeekProfile(holder, profile);
  expect(peekProfileFor(child)).toBe(profile);
  profile?.finish('closed');
  expect(peekProfileFor(child)).toBeUndefined();
});

it('bounds history and ends observation even when a body never becomes ready', () => {
  const profiles = Array.from({ length: 25 }, () => startPeekProfile('side'));
  vi.advanceTimersByTime(5001);
  const records = (globalThis as { __blokPeekProfiles?: unknown[] }).__blokPeekProfiles;
  expect(records).toHaveLength(20);
  expect(profiles.at(-1)?.record.status).toBe('window-ended');
  expect(vi.getTimerCount()).toBe(0);
});
