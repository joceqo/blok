import {afterEach, expect, it, vi} from 'vitest';
import {must} from '../test-helpers';
import {CloudClient} from './client';
import {mountNotificationList} from './notifications';
import {createNotificationTrigger} from './notification-trigger';

const item = {
  id: 'one', type: 'join_requested', actorName: 'Camille', createdAt: '2026-11-25T10:15:00Z', readAt:null,
};
const client = () => new CloudClient({origin:'http://localhost:9000'});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('loads unread activity, marks only the selected notification and updates the badge from the API', async () => {
  const api = client();
  let read = false;
  const request = vi.spyOn(api, 'request').mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      expect(path).toBe('/api/workspaces/atelier/notifications/one/read');
      read = true;
      return {ok:true};
    }
    expect(path).toBe('/api/workspaces/atelier/notifications');
    return {notifications:[{...item, readAt: read ? item.createdAt : null}], unreadCount: read ? 0 : 1};
  });
  const manage = vi.fn();
  const trigger = createNotificationTrigger({client:api, slug:'atelier', onManageRequests:manage});
  document.body.append(trigger.element);
  try {
    await vi.waitFor(() => expect(trigger.element.getAttribute('aria-label')).toContain('1 non lue'));
    trigger.element.click();
    const list = must(document.querySelector('[data-blok-notifications]'));
    await vi.waitFor(() => expect(list.textContent).toContain('Camille demande à rejoindre cet espace.'));
    must([...list.querySelectorAll('button')].find(b => b.textContent === 'Marquer comme lue')).click();
    await vi.waitFor(() => expect(list.querySelector('[data-unread]')).toBeNull());
    expect(trigger.element.getAttribute('aria-label')).toBe('Notifications');
    expect(request.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(1);
    must([...list.querySelectorAll('button')].find(b => b.textContent === 'Voir les demandes')).click();
    expect(manage).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-inbox-pane]')).toBeNull();
  } finally { trigger.destroy(); }
});

it('lets a reader retry a failed fetch and sees the empty state', async () => {
  const api = client();
  const request = vi.spyOn(api,'request').mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({notifications:[], unreadCount:0});
  const view = mountNotificationList(document.body, {client:api, slug:'empty'});
  expect(document.querySelector('[role=status]')?.textContent).toContain('Chargement');
  await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toContain('Impossible'));
  must(document.querySelector('button')).click();
  await vi.waitFor(() => expect(document.querySelector('[role=status]')?.textContent).toBe('Aucune notification.'));
  expect(request).toHaveBeenCalledTimes(2);
  view.destroy();
});

it('keeps reading available after a failed update and never offers administration to an applicant', async () => {
  const api = client();
  vi.spyOn(api,'request').mockResolvedValueOnce({notifications:[{...item,type:'join_rejected'}],unreadCount:1})
    .mockRejectedValueOnce(new Error('unavailable'));
  const view = mountNotificationList(document.body, {client:api,slug:'atelier'});
  await vi.waitFor(() => expect(document.body.textContent).toContain('Votre demande d’accès a été refusée.'));
  const control=must([...document.querySelectorAll('button')].find(b => b.textContent === 'Marquer comme lue'));
  control.click();
  await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toContain('Impossible de marquer'));
  expect(control.disabled).toBe(false);
  expect(document.body.textContent).not.toContain('Voir les demandes');
  view.destroy();
});

it('opens a nonmodal sidebar pane, keeps the editor usable when pinned and returns focus on Escape', () => {
  const api = client();
  vi.spyOn(api, 'request').mockResolvedValue({notifications:[], unreadCount:0});
  const shell = document.createElement('div');
  const sidebar = document.createElement('aside');
  sidebar.setAttribute('data-blok-sidebar', '');
  const editor = document.createElement('textarea');
  const inbox = createNotificationTrigger({client:api, slug:'atelier'});
  sidebar.append(inbox.element);
  shell.append(sidebar, editor);
  document.body.append(shell);
  try {
    inbox.element.click();
    const surface = must(shell.querySelector<HTMLElement>('[data-inbox-pane]'));
    expect(sidebar.nextElementSibling).toBe(surface);
    expect(inbox.element.getAttribute('aria-controls')).toBe(surface.id);
    expect(document.querySelector('dialog, [aria-modal="true"]')).toBeNull();
    const pin = must(surface.querySelector<HTMLButtonElement>('[data-inbox-pin]'));
    pin.click();
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    editor.dispatchEvent(new Event('pointerdown', {bubbles:true}));
    editor.focus();
    expect(document.activeElement).toBe(editor);
    expect(surface.isConnected).toBe(true);
    pin.focus();
    pin.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    expect(surface.isConnected).toBe(false);
    expect(document.activeElement).toBe(inbox.element);
    inbox.element.click();
    editor.dispatchEvent(new Event('pointerdown', {bubbles:true}));
    expect(inbox.element.getAttribute('aria-expanded')).toBe('false');
  } finally { inbox.destroy(); }
});
