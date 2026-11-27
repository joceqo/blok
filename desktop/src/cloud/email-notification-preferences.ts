// Réglages d’envoi d’e-mails. Ils appartiennent à l’espace de travail, pas à
// l’appareil : c’est le serveur qui envoie, donc c’est lui qui doit savoir.
export type EmailNotification = 'activity' | 'always' | 'pageUpdates' | 'digest';

interface PreferenceClient {
  request<T>(path: string, options?: {method?: string; body?: string; signal?: AbortSignal}): Promise<T>;
}
export interface EmailNotificationScope { client: PreferenceClient; slug: string }

// Rien n’est vrai tant que l’espace ne l’a pas dit : personne ne reçoit un
// e-mail qu’il n’a pas demandé, pas même le temps d’un chargement.
const state: Record<EmailNotification, boolean> = {activity: false, always: false, pageUpdates: false, digest: false};
const changes = new EventTarget();
let scope: EmailNotificationScope | null = null;

const path = (slug: string) => `/api/workspaces/${encodeURIComponent(slug)}/email-preferences`;
const announce = () => changes.dispatchEvent(new Event('change'));

export function readEmailNotification(name: EmailNotification): boolean {
  return state[name];
}

/** Charge les choix de l’espace. Un échec laisse tout éteint. */
export async function loadEmailNotifications(next: EmailNotificationScope, signal?: AbortSignal): Promise<void> {
  scope = next;
  try {
    const loaded = await next.client.request<Partial<Record<EmailNotification, boolean>>>(path(next.slug), {signal});
    for (const name of Object.keys(state) as EmailNotification[]) state[name] = loaded?.[name] === true;
  } catch {
    for (const name of Object.keys(state) as EmailNotification[]) state[name] = false;
  }
  announce();
}

/**
 * Montre le choix tout de suite et l’écrit dans l’espace. Si l’écriture
 * échoue, l’interrupteur revient : un réglage resté allumé promettrait des
 * e-mails que personne n’enverra.
 */
export function setEmailNotification(name: EmailNotification, value: boolean): void {
  const previous = state[name];
  state[name] = value;
  announce();
  const active = scope;
  if (!active) return;
  void active.client
    .request(path(active.slug), {method: 'PUT', body: JSON.stringify({[name]: value})})
    .catch(() => {
      if (state[name] !== value) return;
      state[name] = previous;
      announce();
    });
}

export function subscribeEmailNotifications(notify: () => void): () => void {
  changes.addEventListener('change', notify);
  return () => changes.removeEventListener('change', notify);
}

/** Remet l’état d’origine : changement d’espace, déconnexion, tests. */
export function resetEmailNotifications(): void {
  scope = null;
  for (const name of Object.keys(state) as EmailNotification[]) state[name] = false;
  announce();
}
