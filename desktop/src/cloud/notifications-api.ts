import type { CloudClient } from './client';

export interface WorkspaceNotification {
  id: string;
  type: 'join_requested' | 'join_approved' | 'join_rejected' | 'comment_mention' | 'comment_reply' | 'calendar_invitation';
  eventTitle?: string;
  eventStart?: string;
  eventAllDay?: boolean;
  pageId?: string;
  pageTitle?: string;
  actorName: string;
  workspaceName?: string;
  requestMessage?: string;
  requestPending?: boolean;
  decision?: {status: 'approved' | 'rejected'; actorName: string; at: string; isMe?: boolean};
  createdAt: string;
  readAt: string | null;
  archivedAt?: string | null;
}

export interface NotificationListOptions {
  client: Pick<CloudClient, 'request'>;
  slug: string;
  onManageRequests?(): void;
  onOpenPage?(pageId: string): void;
  onInboxItems?(items: WorkspaceNotification[]): void;
  onUnreadCount?(count: number): void;
}

interface Inbox { notifications: WorkspaceNotification[]; unreadCount: number }

function path(slug: string): string {
  return `/api/workspaces/${encodeURIComponent(slug)}/notifications`;
}

export function fetchNotifications({client, slug}: NotificationListOptions, signal: AbortSignal, archived = false): Promise<Inbox> {
  return client.request<Inbox>(path(slug) + (archived ? '?archived=1' : ''), { signal });
}

function updateNotification({client, slug}: NotificationListOptions, id: string, action: 'read' | 'unread' | 'archive' | 'unarchive', signal: AbortSignal): Promise<unknown> {
  return client.request(`${path(slug)}/${encodeURIComponent(id)}/${action}`, {method: 'POST', signal});
}

export function setNotificationRead(options: NotificationListOptions, id: string, read: boolean, signal: AbortSignal): Promise<unknown> {
  return updateNotification(options, id, read ? 'read' : 'unread', signal);
}

export function setNotificationArchived(options: NotificationListOptions, id: string, archived: boolean, signal: AbortSignal): Promise<unknown> {
  return updateNotification(options, id, archived ? 'archive' : 'unarchive', signal);
}

export function readNotification(options: NotificationListOptions, id: string, signal: AbortSignal): Promise<unknown> {
  return setNotificationRead(options, id, true, signal);
}

export function readAllNotifications({client, slug}: NotificationListOptions, signal: AbortSignal): Promise<unknown> {
  return client.request(`${path(slug)}/read-all`, {method:'POST', signal});
}
