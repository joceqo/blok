import {afterEach, expect, it, vi} from 'vitest';
import {getTimeFormatter, initializeDisplayPreferences, readChatNewline, readContrast, readTimeFormat, setChatNewline, setContrast, setTimeFormat} from './display-preferences';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-desktop-contrast');
  document.documentElement.removeAttribute('data-desktop-high-contrast');
  document.documentElement.removeAttribute('data-blok-chat-enter-newline');
  document.documentElement.removeAttribute('data-desktop-time-format');
  vi.unstubAllGlobals();
});

it('restores the saved clock format and follows changes from another window', () => {
  setTimeFormat('12h');
  document.documentElement.removeAttribute('data-desktop-time-format');
  const stop = initializeDisplayPreferences();
  try {
    expect(readTimeFormat()).toBe('12h');
    expect(getTimeFormatter().resolvedOptions().hourCycle).toBe('h12');
    const key = 'blok:desktop:time-format';
    localStorage.setItem(key, '24h');
    window.dispatchEvent(new StorageEvent('storage', {key, newValue: '24h'}));
    expect(getTimeFormatter().resolvedOptions().hourCycle).toBe('h23');
    localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent('storage', {key, newValue: null}));
    expect(readTimeFormat()).toBe('system');
    const systemHourCycle = new Intl.DateTimeFormat(undefined, {hour: '2-digit'}).resolvedOptions().hourCycle;
    expect(getTimeFormatter().resolvedOptions().hourCycle).toBe(systemHourCycle);
  } finally { stop(); }
});

it('follows system contrast unless overridden, and restores stored choices on startup', () => {
  const query = Object.assign(new EventTarget(), {matches: true});
  vi.stubGlobal('matchMedia', () => query);
  const stop = initializeDisplayPreferences();
  try {
    const active = () => document.documentElement.hasAttribute('data-desktop-high-contrast');
    expect(active()).toBe(true);
    query.matches = false;
    query.dispatchEvent(new Event('change'));
    expect(active()).toBe(false);
    setContrast('more');
    expect(active()).toBe(true);
    query.dispatchEvent(new Event('change'));
    expect(active()).toBe(true);
    query.matches = true;
    setContrast('standard');
    expect(active()).toBe(false);
    setChatNewline(true);
  } finally { stop(); }
  document.documentElement.removeAttribute('data-blok-chat-enter-newline');
  document.documentElement.removeAttribute('data-desktop-contrast');
  const stopAfterReload = initializeDisplayPreferences();
  try {
    expect(readContrast()).toBe('standard');
    expect(readChatNewline()).toBe(true);
    expect(document.documentElement.hasAttribute('data-desktop-high-contrast')).toBe(false);
  } finally { stopAfterReload(); }
});
