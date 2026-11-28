const keys = {
  pinned: 'blok:desktop:inbox-pinned:v1',
  comments: 'blok:desktop:notify-comments:v1',
  badge: 'blok:desktop:inbox-unread-badge:v1',
};
type Preference = keyof typeof keys;
const changes = new EventTarget();
const session = new Map<Preference, boolean>();

export function readInboxPreference(name: Preference): boolean {
  const fallback = session.get(name) ?? (name === 'badge');
  try {
    const value = localStorage.getItem(keys[name]);
    return session.get(name) ?? (value === null ? fallback : value === 'true');
  } catch { return fallback; }
}

export function setInboxPreference(name: Preference, value: boolean): void {
  try {
    localStorage.setItem(keys[name], String(value));
    session.delete(name);
  } catch { session.set(name, value); }
  changes.dispatchEvent(new Event('change'));
}

export function subscribeInboxPreferences(listener: () => void): () => void {
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null || Object.values(keys).includes(event.key)) listener();
  };
  changes.addEventListener('change', listener);
  window.addEventListener('storage', storageChanged);
  return () => {
    changes.removeEventListener('change', listener);
    window.removeEventListener('storage', storageChanged);
  };
}
