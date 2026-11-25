import {afterEach, expect, it, vi} from 'vitest';
import {must} from '../test-helpers';
import {CloudClient} from './client';
import {mountNotificationList} from './notifications';
import {createNotificationTrigger} from './notification-trigger';

const item = {
  id: 'one', type: 'join_requested', actorName: 'Camille', createdAt: '2026-11-25T10:15:00Z', readAt:null,
};
const client = () => new CloudClient({origin:'http://localhost:9000'});
afterEach(() => { document.body.replaceChildren(); localStorage.removeItem('blok:desktop:inbox-pinned:v1'); vi.restoreAllMocks(); });

it('loads unread activity, marks only the selected notification and updates the badge from the API', async () => {
  const api = client();
  let read = false;
  let completeRefresh!: () => void;
  const pendingRefresh = new Promise<void>(resolve => { completeRefresh = resolve; });
  const request = vi.spyOn(api, 'request').mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      expect(path).toBe('/api/workspaces/atelier/notifications/one/read');
      read = true;
      return {ok:true};
    }
    expect(path).toBe('/api/workspaces/atelier/notifications');
    if (read) await pendingRefresh;
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
    const markRead = must([...list.querySelectorAll('button')].find(b => b.textContent === 'Marquer comme lue'));
    markRead.focus();
    markRead.click();

    await vi.waitFor(() => expect(list.querySelector('[role=status]')?.textContent).toContain('Chargement'));
    completeRefresh();
    await vi.waitFor(() => expect(list.querySelector('[data-unread]')).toBeNull());
    expect(document.activeElement).toBe(markRead);
    expect(markRead.textContent).toBe('Marquer comme non lue');
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
  must(document.querySelector<HTMLButtonElement>('[role=alert] button')).click();
  await vi.waitFor(() => expect(document.querySelector('[role=status]')?.textContent).toBe('Vous êtes à jour.'));
  expect(document.querySelector('[aria-label="Plus d’actions"]')).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
  view.destroy();
});

it('keeps reading available after a failed update and never offers administration to an applicant', async () => {
  const api = client();
  vi.spyOn(api,'request').mockResolvedValueOnce({notifications:[{...item,type:'join_rejected'}],unreadCount:1})
    .mockRejectedValueOnce(new Error('unavailable'));
  const view = mountNotificationList(document.body, {client:api,slug:'atelier'});
  await vi.waitFor(() => expect(document.querySelector('[data-inbox-decision]')?.textContent).toContain('Refusée par Camille le '));
  expect(document.querySelector('[data-inbox-description]')?.textContent).toBe('Votre demande d’accès');
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
  const bounds = new DOMRect(0, 40, 270, window.innerHeight - 40);
  vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(bounds);
  const editor = document.createElement('textarea');
  const inbox = createNotificationTrigger({client:api, slug:'atelier'});
  sidebar.append(inbox.element);
  shell.append(sidebar, editor);
  document.body.append(shell);
  try {
    inbox.element.click();
    const surface = must(shell.querySelector<HTMLElement>('[data-inbox-pane]'));
    expect(sidebar.nextElementSibling).toBe(surface);
    expect(surface.hasAttribute('data-inbox-sheet')).toBe(true);
    expect(surface.style.getPropertyValue('--inbox-left')).toBe('270px');
    expect(surface.style.getPropertyValue('--inbox-top')).toBe('40px');
    expect(surface.style.getPropertyValue('--inbox-bottom')).toBe('0px');
    expect(inbox.element.getAttribute('aria-controls')).toBe(surface.id);
    expect(document.querySelector('dialog, [aria-modal="true"]')).toBeNull();
    const pin = must(surface.querySelector<HTMLButtonElement>('[data-inbox-pin]'));
    const backdrop = must(shell.querySelector<HTMLElement>('[data-inbox-backdrop]'));
    expect(backdrop.hidden).toBe(false);
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    pin.click();
    expect(document.activeElement).toBe(pin);
    expect(backdrop.hidden).toBe(true);
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
    const reopenedPin = must(shell.querySelector<HTMLButtonElement>('[data-inbox-pin]'));
    expect(reopenedPin.getAttribute('aria-pressed')).toBe('true');
    reopenedPin.click();
    const outside = must(shell.querySelector<HTMLElement>('[data-inbox-backdrop]'));
    expect(outside.hidden).toBe(false);
    outside.dispatchEvent(new Event('pointerdown', {bubbles:true}));
    expect(outside.isConnected).toBe(true);
    outside.click();
    expect(inbox.element.getAttribute('aria-expanded')).toBe('false');
    expect(outside.isConnected).toBe(false);
    inbox.element.click();
    expect(must(shell.querySelector('[data-inbox-pin]')).getAttribute('aria-pressed')).toBe('false');
  } finally { inbox.destroy(); }
});

it('keeps the same sheet when reopening during its exit, then removes it after a complete exit', async () => {
  const api = client();
  vi.spyOn(api, 'request').mockResolvedValue({notifications:[], unreadCount:0});
  const inbox = createNotificationTrigger({client:api, slug:'atelier'});
  const sidebar = document.createElement('aside');
  sidebar.setAttribute('data-blok-sidebar', '');
  document.body.append(sidebar);
  sidebar.append(inbox.element);
  try {
    inbox.element.click();
    const sheet = must(document.querySelector<HTMLElement>('[data-inbox-pane]'));
    const slide = must(sheet.querySelector('[data-inbox-slide]'));
    let endExit!: () => void;
    Object.defineProperty(slide, 'getAnimations', {value: () => [{
      transitionProperty:'transform', finished:new Promise<void>(resolve => { endExit = resolve; }),
    }]});
    inbox.element.click();
    expect(sheet.inert).toBe(true);
    inbox.element.click();
    endExit();
    await Promise.resolve();
    expect(document.querySelector('[data-inbox-pane]')).toBe(sheet);
    expect(sheet.inert).toBe(false);
    inbox.element.click();
    expect(sheet.isConnected).toBe(true);
    endExit();
    await Promise.resolve();
    expect(sheet.isConnected).toBe(false);
    expect(document.querySelector('[data-inbox-backdrop]')).toBeNull();
  } finally { inbox.destroy(); }
});

it('filters locally, keeps the total unread count and dismisses a header menu before the panel', async () => {
  const api = client();
  const request = vi.spyOn(api, 'request').mockResolvedValue({
    notifications: [item, {...item, id:'two', actorName:'Lou', readAt:item.createdAt}], unreadCount:1,
  });
  const trigger = createNotificationTrigger({client:api, slug:'atelier'});
  document.body.append(trigger.element);
  const key = (element: Element, name: string) =>
    element.dispatchEvent(new KeyboardEvent('keydown', {key:name, bubbles:true, cancelable:true}));
  try {
    trigger.element.click();
    const sheet = must(document.querySelector('[data-inbox-pane]'));
    await vi.waitFor(() => expect(sheet.querySelectorAll('[data-inbox-row]')).toHaveLength(2));
    const filter = must(sheet.querySelector<HTMLButtonElement>('[aria-label="Filtrer les notifications"]'));
    const actions = must(sheet.querySelector<HTMLButtonElement>('[aria-label="Plus d’actions"]'));
    const before = request.mock.calls.length;
    filter.click();
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Toutes les notifications'));
    key(must(document.activeElement), 'ArrowDown');
    const unread = must([...sheet.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(b => b.textContent === 'Non lues'));
    expect(document.activeElement).toBe(unread);
    unread.click();
    await vi.waitFor(() => expect(sheet.querySelectorAll('[data-inbox-row]')).toHaveLength(1));
    expect(trigger.element.title).toContain('1 non lue');
    expect(document.activeElement).toBe(filter);
    expect(request.mock.calls).toHaveLength(before);
    filter.click();
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Non lues'));
    key(must(document.activeElement), 'Escape');
    await vi.waitFor(() => expect(sheet.querySelector('[role=dialog]')).toBeNull());
    expect(sheet.isConnected).toBe(true);
    expect(document.activeElement).toBe(filter);
    actions.click();
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Tout marquer comme lu'));
    must([...sheet.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(b=>b.textContent.trim()==='Actualiser')).click();
    await vi.waitFor(() => expect(request.mock.calls).toHaveLength(before + 1));
    expect(document.activeElement).toBe(actions);
    expect(sheet.querySelectorAll('[data-inbox-row]')).toHaveLength(1);
    filter.click();
    await vi.waitFor(() => expect(sheet.querySelector('[role=dialog]')).toBeTruthy());
    must(sheet.querySelector<HTMLButtonElement>('[role=dialog] button')).click();
    await vi.waitFor(() => expect(sheet.querySelectorAll('[data-inbox-row]')).toHaveLength(2));
  } finally { trigger.destroy(); }
});

it('can retry a failed bulk acknowledgment, updates the badge and disables it once all are read', async () => {
  const api = client();
  let attempts = 0;
  let count = 67;
  const request = vi.spyOn(api,'request').mockImplementation(async (path,init) => {
    if (init?.method === 'POST') {
      expect(path).toBe('/api/workspaces/atelier/notifications/read-all');
      if (++attempts === 1) throw Error('offline');
      count = 0;
      return {ok:true};
    }
    return {notifications:[{...item,readAt:count ? null : item.createdAt}], unreadCount:count};
  });
  const trigger = createNotificationTrigger({client:api,slug:'atelier'});
  document.body.append(trigger.element);
  const byLabel = (label:string) => must(document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`));
  const bulk = () => must([...document.querySelectorAll<HTMLButtonElement>('[data-inbox-menu] button')].find(b=>b.textContent.trim()==='Tout marquer comme lu'));
  try {
    trigger.element.click();
    await vi.waitFor(() => expect(trigger.element.title).toContain('67 non lues'));
    byLabel('Plus d’actions').click();
    await vi.waitFor(() => expect(bulk().disabled).toBe(false));
    bulk().click();
    await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toContain('Impossible de marquer toutes'));
    expect(trigger.element.title).toContain('67 non lues');
    byLabel('Plus d’actions').click();
    await vi.waitFor(() => expect(bulk().disabled).toBe(false));
    bulk().click();
    await vi.waitFor(() => expect(document.querySelector('[data-unread]')).toBeNull());
    expect(trigger.element.title).toBe('Notifications');
    expect(request.mock.calls.filter(([,init]) => init?.method==='POST')).toHaveLength(2);
    byLabel('Plus d’actions').click();
    await vi.waitFor(() => expect(bulk().disabled).toBe(true));
  } finally { trigger.destroy(); }
});
