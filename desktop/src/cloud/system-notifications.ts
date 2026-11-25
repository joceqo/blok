import {invoke} from '@tauri-apps/api/core';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {readInboxPreference} from './inbox-preferences';
import type {WorkspaceNotification} from './notifications-api';

export type SystemPermission = NotificationPermission | 'unavailable';
export const nativeMacNotifications = () => '__TAURI_INTERNALS__' in window && /Mac/i.test(navigator.platform);
export async function systemPermission(request = false): Promise<SystemPermission> {
  if (nativeMacNotifications()) return invoke<SystemPermission>('notification_permission', {request});
  if (typeof window.Notification !== 'function' || !window.isSecureContext) return 'unavailable';
  if (request && Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

export function openSystemNotificationSettings(): Promise<void> {
  return invoke('open_notification_settings');
}

export async function sendSystemNotice(id: string, body: string) {
  if (nativeMacNotifications()) return invoke<void>('post_system_notification', {id, body});
  new Notification('Blok', {tag: id, body});
}

export function paintSystemBadge(count: number): void {
  if (nativeMacNotifications()) void getCurrentWindow().setBadgeCount(count || undefined).catch(() => {});
}

export function discussionAlerts() {
  let newest: number | undefined;
  let seen = new Set<string>();
  return (items: WorkspaceNotification[], signal: AbortSignal) => {
    // The first poll is the baseline. Old unread rows returning to the top after
    // a filter or an ACL change must not make the device replay the old inbox.
    const next = items.filter(item => !item.readAt && !item.archivedAt &&
      (item.type === 'comment_mention' || item.type === 'comment_reply'));
    const fresh = newest === undefined ? [] : next.filter(item => Date.parse(item.createdAt) >= newest! && !seen.has(item.id));
    const latest = Math.max(newest ?? -Infinity, ...items.map(item => Date.parse(item.createdAt)).filter(Number.isFinite));
    if (latest !== newest) seen = new Set();
    for (const item of items) if (Date.parse(item.createdAt) === latest) seen.add(item.id);
    newest = latest;
    if (!fresh.length || !readInboxPreference('comments')) return;
    void (async () => {
      if (await systemPermission() !== 'granted') return;
      for (const item of fresh) {
        if (signal.aborted || !readInboxPreference('comments')) return;
        const message = item.type === 'comment_mention' ? 'Vous avez été mentionné·e dans un commentaire.' : 'Votre commentaire a reçu une réponse.';
        await sendSystemNotice('discussion-' + item.id, message);
      }
    })().catch(() => { /* Permission may change between the poll and delivery. */ });
  };
}
