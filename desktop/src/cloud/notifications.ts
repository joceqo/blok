import type { CloudClient } from './client';
import { button, el } from '../ui/dom';
import './notifications.css';

export interface WorkspaceNotification {
  id: string;
  type: 'join_requested' | 'join_approved' | 'join_rejected';
  actorName: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationListOptions {
  client: Pick<CloudClient, 'request'>;
  slug: string;
  onManageRequests?(): void;
  onUnreadCount?(count: number): void;
}

interface Inbox { notifications: WorkspaceNotification[]; unreadCount: number }

const dates = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

function path(slug: string): string {
  return `/api/workspaces/${encodeURIComponent(slug)}/notifications`;
}

export function fetchNotifications({client, slug}: NotificationListOptions, signal: AbortSignal): Promise<Inbox> {
  return client.request<Inbox>(path(slug), { signal });
}

function describe(item: WorkspaceNotification): string {
  switch (item.type) {
    case 'join_requested': return `${item.actorName || 'Un utilisateur'} demande à rejoindre cet espace.`;
    case 'join_approved': return 'Votre demande d’accès a été acceptée.';
    case 'join_rejected': return 'Votre demande d’accès a été refusée.';
  }
}

export function mountNotificationList(container: HTMLElement, options: NotificationListOptions) {
  const panel = el('section', { attribute: 'data-blok-notifications' });
  const title = el('h2', { text: 'Notifications' });
  const refresh = button({ label: 'Actualiser', onClick: () => load() });
  const status = el('p', { attrs: { role: 'status' } });
  const error = el('p', { attrs: { role: 'alert' } });
  const list = el('ul', { attrs: { 'aria-label': 'Notifications de l’espace' } });
  panel.append(el('header', {children: [title, refresh]}), status, error, list);
  container.append(panel);
  const life = new AbortController();

  async function markRead(item: WorkspaceNotification, row: HTMLLIElement, control: HTMLButtonElement): Promise<void> {
    control.disabled = true;
    error.textContent = '';
    try {
      await options.client.request(`${path(options.slug)}/${encodeURIComponent(item.id)}/read`, { method: 'POST', signal: life.signal });
      if (life.signal.aborted) return;
      // A concurrent refresh may have replaced this row. Reload the canonical
      // count so another tab marking the same item cannot decrement it twice.
      await load();
      if (!life.signal.aborted && (row.contains(document.activeElement) || document.activeElement === document.body)) refresh.focus();
    } catch {
      if (life.signal.aborted) return;
      error.textContent = 'Impossible de marquer la notification comme lue. Réessayez.';
      control.disabled = false;
    }
  }

  function render(item: WorkspaceNotification): HTMLLIElement {
    const row = el('li');
    row.toggleAttribute('data-unread', !item.readAt);
    const date = el('time', {text: dates.format(new Date(item.createdAt)), attrs: {datetime: item.createdAt}});
    const content = el('div', {children: [el('p', {text: describe(item)}), date]});
    row.append(content);
    if (!item.readAt) {
      const read = button({label: 'Marquer comme lue', onClick: () => markRead(item, row, read)});
      row.append(read);
    }
    if (item.type === 'join_requested' && options.onManageRequests) {
      content.append(button({label: 'Voir les demandes', onClick: options.onManageRequests}));
    }
    return row;
  }

  let generation = 0;
  async function load(): Promise<void> {
    const current = ++generation;
    status.textContent = 'Chargement des notifications…';
    error.textContent = '';
    refresh.disabled = true;
    try {
      const result = await fetchNotifications(options, life.signal);
      if (life.signal.aborted || current !== generation) return;
      list.replaceChildren(...result.notifications.map(render));
      status.textContent = result.notifications.length ? '' : 'Aucune notification.';
      options.onUnreadCount?.(result.unreadCount);
    } catch {
      if (life.signal.aborted || current !== generation) return;
      list.replaceChildren();
      status.textContent = '';
      error.textContent = 'Impossible de charger les notifications. Réessayez.';
    } finally {
      if (current === generation) refresh.disabled = false;
    }
  }
  void load();
  return { destroy() { life.abort(); panel.remove(); } };
}
