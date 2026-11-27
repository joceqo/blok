import {shellLocale} from './shell-i18n';
export type Contrast = 'system' | 'more' | 'standard';
export type TimeFormat = 'system' | '12h' | '24h';

const contrastKey = 'blok:desktop:contrast';
const newlineKey = 'blok:desktop:chat-enter-newline';
const timeFormatKey = 'blok:desktop:time-format';
const timeZoneKey = 'blok:desktop:time-zone';
const autoTimeZoneKey = 'blok:desktop:time-zone-auto';
const changed = 'blok:display-preferences';
const clocks = new Map<string, Intl.DateTimeFormat>();

function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Keep the active document preference. */ }
}

export function readContrast(): Contrast {
  const value = document.documentElement.dataset.desktopContrast ?? stored(contrastKey);
  return value === 'more' || value === 'standard' ? value : 'system';
}

function applyContrast(value: Contrast): void {
  const root = document.documentElement;
  root.dataset.desktopContrast = value;
  const system = value === 'system' && window.matchMedia?.('(prefers-contrast: more)').matches;
  root.toggleAttribute('data-desktop-high-contrast', value === 'more' || Boolean(system));
}

export function setContrast(value: Contrast): void {
  save(contrastKey, value);
  applyContrast(value);
  window.dispatchEvent(new Event(changed));
}

export function readChatNewline(): boolean {
  return document.documentElement.hasAttribute('data-blok-chat-enter-newline');
}

export function setChatNewline(enabled: boolean): void {
  save(newlineKey, String(enabled));
  document.documentElement.toggleAttribute('data-blok-chat-enter-newline', enabled);
  window.dispatchEvent(new Event(changed));
}

export function readTimeFormat(): TimeFormat {
  const value = document.documentElement.dataset.desktopTimeFormat ?? stored(timeFormatKey);
  return value === '12h' || value === '24h' ? value : 'system';
}

export function setTimeFormat(value: TimeFormat): void {
  save(timeFormatKey, value);
  document.documentElement.dataset.desktopTimeFormat = value;
  window.dispatchEvent(new Event(changed));
}

/** The zone the device reports, which is what the automatic setting follows. */
export function readDeviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function usableTimeZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  // An unknown name makes every later formatter throw: keep it out.
  try { new Intl.DateTimeFormat(undefined, {timeZone: zone}); return zone; } catch { return null; }
}

export function readAutoTimeZone(): boolean {
  const value = document.documentElement.dataset.desktopAutoTimeZone ?? stored(autoTimeZoneKey);
  return value !== 'false';
}

export function setAutoTimeZone(enabled: boolean): void {
  save(autoTimeZoneKey, String(enabled));
  document.documentElement.dataset.desktopAutoTimeZone = String(enabled);
  window.dispatchEvent(new Event(changed));
}

/** The zone chosen by hand, whether or not the automatic setting is using it. */
export function readChosenTimeZone(): string {
  const value = document.documentElement.dataset.desktopTimeZone || stored(timeZoneKey);
  return usableTimeZone(value) ?? readDeviceTimeZone();
}

/** The zone everything shows times in: the device's while the automatic setting is on. */
export function readTimeZone(): string {
  return readAutoTimeZone() ? readDeviceTimeZone() : readChosenTimeZone();
}

export function setTimeZone(zone: string): void {
  save(timeZoneKey, zone);
  document.documentElement.dataset.desktopTimeZone = zone;
  window.dispatchEvent(new Event(changed));
}

export function getTimeFormatter(): Intl.DateTimeFormat {
  const format = readTimeFormat();
  const locale = shellLocale();
  const key = locale + '/' + format;
  let clock = clocks.get(key);
  if (!clock) {
    const hourCycle = format === '12h' ? 'h12' : format === '24h' ? 'h23' : new Intl.DateTimeFormat(undefined, {hour: 'numeric'}).resolvedOptions().hourCycle;
    clock = new Intl.DateTimeFormat(locale, {hour: format === '12h' ? 'numeric' : '2-digit', minute: '2-digit', hourCycle});
    clocks.set(key, clock);
  }
  return clock;
}

export function subscribeDisplayPreferences(notify: () => void): () => void {
  window.addEventListener(changed, notify);
  return () => window.removeEventListener(changed, notify);
}

export function initializeDisplayPreferences(): () => void {
  function restore(): void {
    const value = stored(contrastKey);
    applyContrast(value === 'more' || value === 'standard' ? value : 'system');
    document.documentElement.toggleAttribute('data-blok-chat-enter-newline', stored(newlineKey) === 'true');
    document.documentElement.dataset.desktopTimeFormat = stored(timeFormatKey) ?? 'system';
    document.documentElement.dataset.desktopTimeZone = stored(timeZoneKey) ?? '';
    document.documentElement.dataset.desktopAutoTimeZone = stored(autoTimeZoneKey) === 'false' ? 'false' : 'true';
    window.dispatchEvent(new Event(changed));
  }
  restore();
  const query = window.matchMedia?.('(prefers-contrast: more)');
  const systemChanged = () => applyContrast(readContrast());
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null || event.key === contrastKey || event.key === newlineKey || event.key === timeFormatKey || event.key === timeZoneKey || event.key === autoTimeZoneKey) restore();
  };
  query?.addEventListener('change', systemChanged);
  window.addEventListener('storage', storageChanged);
  return () => {
    query?.removeEventListener('change', systemChanged);
    window.removeEventListener('storage', storageChanged);
  };
}
