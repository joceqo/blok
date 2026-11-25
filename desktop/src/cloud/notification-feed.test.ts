import {expect, it, vi} from 'vitest';
import {mountNotificationList, type WorkspaceNotification} from './notifications';
import {CloudClient} from './client';

it('groups notifications by local date and only opens pending requests with an available action', async () => {
  const now = new Date();
  const old = new Date(now);
  old.setDate(now.getDate() - 12);
  const pending: WorkspaceNotification = {
    id:'pending', type:'join_requested', actorName:'Camille', workspaceName:'Atelier',
    createdAt:now.toISOString(), readAt:null, requestPending:true, requestMessage:'Je travaille avec Camille sur le planning.',
  };
  const approved: WorkspaceNotification = {
    ...pending, id:'approved', actorName:'Lou', createdAt:old.toISOString(), readAt:old.toISOString(),
    decision:{status:'approved', actorName:'Sacha', isMe:true, at:old.toISOString()},
  };
  const client = new CloudClient({origin:'http://localhost:9000'});
  vi.spyOn(client, 'request').mockResolvedValue({notifications:[approved, pending], unreadCount:1});
  const onManageRequests = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const inbox = mountNotificationList(host, {client, slug:'atelier', onManageRequests});
  try {
    await vi.waitFor(() => expect(host.querySelectorAll('[data-inbox-row]')).toHaveLength(2));
    expect([...host.querySelectorAll('h3')].map(group => group.textContent)).toEqual(['Aujourd’hui', 'Plus ancien']);
    const [first, second] = host.querySelectorAll('[data-inbox-row]');
    expect(first.querySelector('[data-inbox-description]')?.textContent).toBe('Camille demande à rejoindre Atelier.');
    expect(first.querySelector('[data-inbox-decision]')?.textContent).toBe('En attente de décision');
    expect(first.querySelector('[data-inbox-message]')?.textContent).toBe(pending.requestMessage);
    expect(first.querySelector('[data-inbox-target] svg')).toBeTruthy();
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe(pending.createdAt);
    expect(first.querySelector('time')?.getAttribute('aria-label')).toBeTruthy();
    first.querySelector<HTMLButtonElement>('[data-inbox-open-request]')?.click();
    expect(onManageRequests).toHaveBeenCalledOnce();
    expect(second.querySelector('[data-inbox-decision]')?.textContent).toContain('Approuvée par vous le ');
    expect(second.querySelector('[data-inbox-open-request]')).toBeNull();
    expect(second.querySelectorAll('[role=group] button')).toHaveLength(2);
  } finally {
    inbox.destroy();
    host.remove();
    vi.restoreAllMocks();
  }
});

it('restores archived notifications, updates unread status and returns focus when a card leaves the list', async () => {
  const client = new CloudClient({origin:'http://localhost:9000'});
  const createdAt = new Date().toISOString();
  const note: WorkspaceNotification = {
    id:'one', type:'join_approved', actorName:'Sacha', workspaceName:'Atelier', createdAt,
    readAt:createdAt, archivedAt:null,
  };
  const request = vi.spyOn(client, 'request').mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      if (url.endsWith('/unread')) note.readAt = null;
      else if (url.endsWith('/archive')) note.archivedAt = createdAt;
      else if (url.endsWith('/unarchive')) note.archivedAt = null;
      else throw Error('Unexpected action');
      return {ok:true};
    }
    return {
      notifications: Boolean(note.archivedAt) === url.endsWith('?archived=1') ? [{...note}] : [],
      unreadCount: note.archivedAt || note.readAt ? 0 : 1,
    };
  });
  const host = document.createElement('div');
  document.body.append(host);
  const onUnreadCount = vi.fn();
  const inbox = mountNotificationList(host, {client, slug:'atelier', onUnreadCount});
  const button = (label: string) => [...host.querySelectorAll('button')].find(el => el.textContent === label)!;
  try {
    await vi.waitFor(() => expect(host.querySelector('[data-inbox-decision]')?.textContent).toContain('Approuvée par Sacha le '));
    button('Marquer comme non lue').click();
    await vi.waitFor(() => expect(onUnreadCount).toHaveBeenLastCalledWith(1));
    button('Archiver la notification').focus();
    button('Archiver la notification').click();
    await vi.waitFor(() => expect(host.querySelector('[data-inbox-row]')).toBeNull());
    const filter = host.querySelector<HTMLButtonElement>('[aria-label="Filtrer les notifications"]')!;
    expect(document.activeElement).toBe(filter);
    expect(onUnreadCount).toHaveBeenLastCalledWith(0);
    filter.click();
    await vi.waitFor(() => expect(button('Archivées')).toBeTruthy());
    button('Archivées').click();
    await vi.waitFor(() => expect(button('Restaurer la notification')).toBeTruthy());
    button('Restaurer la notification').click();
    await vi.waitFor(() => expect(host.querySelector('[role=status]')?.textContent).toBe('Aucune notification archivée.'));
    expect(onUnreadCount).toHaveBeenLastCalledWith(1);
    expect(request.mock.calls.filter(([,init]) => init?.method === 'POST').map(([url]) => url.split('/').at(-1)))
      .toEqual(['unread','archive','unarchive']);
  } finally {
    inbox.destroy();
    host.remove();
    vi.restoreAllMocks();
  }
});
