import { IconCheck, IconMail, IconPeople } from '../../../src/components/icons';
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
  const emptyIcon = el('span', { attrs: { 'aria-hidden':'true', 'data-inbox-empty-icon':'' } });
  emptyIcon.innerHTML = IconMail.trim().replace(/>\s+</g, '><');
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
    const avatar = el('span', { attrs: { 'data-inbox-avatar':'', 'aria-hidden':'true' } });
    if (item.type === 'join_requested' && item.actorName.trim()) {
      avatar.textContent = Array.from(item.actorName.trim())[0].toLocaleUpperCase('fr-FR');
    } else {
      avatar.innerHTML = IconPeople;
    }
    row.append(avatar, content);
    if (!item.readAt) {
      const read = button({label: 'Marquer comme lue', onClick: () => markRead(item, row, read)});
      read.title = 'Marquer comme lue';
      const label = el('span', {text: read.title, attribute: 'data-inbox-read-label'});
      read.innerHTML = IconCheck.trim().replace(/>\s+</g, '><');
      read.append(label);
      read.setAttribute('data-inbox-read', '');
      row.append(read);
    }
    if (item.type === 'join_requested' && options.onManageRequests) {
      content.append(button({label: 'Voir les demandes', onClick: options.onManageRequests}));
    }
    return row;
  }

  let generation = 0;
  let lastRendered: string | undefined;
  async function load(quiet = false): Promise<void> {
    if (quiet && refresh.disabled) return;
    const current = ++generation;
    if (!quiet) {
      status.textContent = 'Chargement des notifications…';
      error.textContent = '';
    }
    refresh.disabled = true;
    try {
      const result = await fetchNotifications(options, life.signal);
      if (life.signal.aborted || current !== generation) return;
      const snapshot = JSON.stringify(result.notifications);
      options.onUnreadCount?.(result.unreadCount);
      if (quiet && lastRendered === snapshot) return;
      lastRendered = snapshot;
      error.textContent = '';
      list.replaceChildren(...result.notifications.map(render));
      status.replaceChildren();
      if (!result.notifications.length) status.append(emptyIcon, 'Aucune notification.');
    } catch {
      if (life.signal.aborted || current !== generation || quiet) return;
      lastRendered = undefined;
      list.replaceChildren();
      status.textContent = '';
      error.textContent = 'Impossible de charger les notifications. Réessayez.';
    } finally {
      if (current === generation) refresh.disabled = false;
    }
  }
  void load();
  return { refresh: () => load(true), destroy() { life.abort(); panel.remove(); } };
}
