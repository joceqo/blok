// Réglages d’envoi d’e-mails, gardés sur cet appareil : aucun espace de travail ne les stocke encore.
const keys = {
  activity: 'blok:desktop:email-activity:v1',
  always: 'blok:desktop:email-always:v1',
  pageUpdates: 'blok:desktop:email-page-updates:v1',
  digest: 'blok:desktop:email-digest:v1',
};
export type EmailNotification = keyof typeof keys;
// Ne doubler par e-mail ce que Blok affiche déjà se décide, le reste part sans rien demander.
const defaults: Record<EmailNotification, boolean> = {activity: true, always: false, pageUpdates: true, digest: true};
const changes = new EventTarget();
const session = new Map<EmailNotification, boolean>();

export function readEmailNotification(name: EmailNotification): boolean {
  const pending = session.get(name);
  if (pending !== undefined) return pending;
  try {
    const value = localStorage.getItem(keys[name]);
    return value === null ? defaults[name] : value === 'true';
  } catch { return defaults[name]; }
}

export function setEmailNotification(name: EmailNotification, value: boolean): void {
  try {
    localStorage.setItem(keys[name], String(value));
    session.delete(name);
  } catch { session.set(name, value); }
  changes.dispatchEvent(new Event('change'));
}

export function subscribeEmailNotifications(listener: () => void): () => void {
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
