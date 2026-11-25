import {afterEach, expect, it, vi} from 'vitest';
import {createSidebarPreferences} from '../../src/shell/sidebar-preferences';
import {createNotificationTrigger} from './cloud/notification-trigger';
import {mountShellNavigationSettings} from './shell-navigation-settings';
import {must} from './test-helpers';

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function switchNamed(host: HTMLElement, text: string): HTMLButtonElement {
  return must([...host.querySelectorAll<HTMLButtonElement>('[role=switch]')].find(button =>
    document.getElementById(button.getAttribute('aria-labelledby') || '')?.textContent === text));
}

it('edits the sidebar model shared with the workspace and remembers the choices for that workspace', async () => {
  localStorage.setItem('blok:sidebar:sections:atelier', JSON.stringify({events: false, favorites: true}));
  const sidebar = createSidebarPreferences('atelier', true);
  const host = document.createElement('div');
  document.body.append(host);
  const panel = mountShellNavigationSettings(host, {kind: 'sidebar', sidebar});
  try {
    expect(switchNamed(host, 'Événements à venir').getAttribute('aria-checked')).toBe('false');
    switchNamed(host, 'Favoris').click();
    expect(sidebar.getSnapshot().favorites).toBe(false);
    sidebar.set('events', true);
    await vi.waitFor(() => expect(switchNamed(host, 'Événements à venir').getAttribute('aria-checked')).toBe('true'));
    expect(createSidebarPreferences('atelier', true).getSnapshot()).toEqual({events: true, favorites: false});
    expect(createSidebarPreferences('autre', true).getSnapshot().favorites).toBe(true);
  } finally { panel.destroy(); }
});

it('applies unread badge and pin switches to the mounted inbox, and reflects changes made inside the inbox', async () => {
  const host = document.createElement('div');
  const rail = document.createElement('aside');
  rail.setAttribute('data-blok-sidebar', '');
  const inbox = createNotificationTrigger({slug:'atelier', client:{request:vi.fn().mockResolvedValue({notifications:[], unreadCount:3})}});
  rail.append(inbox.element);
  document.body.append(rail, host);
  const panel = mountShellNavigationSettings(host, {kind: 'notifications'});
  try {
    const badge = must(inbox.element.querySelector<HTMLElement>('[data-inbox-count]'));
    await vi.waitFor(() => expect(badge.hidden).toBe(false));
    switchNamed(host, 'Compteur de notifications non lues').click();
    expect(badge.hidden).toBe(true);
    expect(inbox.element.getAttribute('aria-label')).toBe('Notifications');
    inbox.element.click();
    const pin = must(document.querySelector<HTMLButtonElement>('[data-inbox-pin]'));
    switchNamed(host, 'Épingler le volet').click();
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    pin.click();
    await vi.waitFor(() => expect(switchNamed(host, 'Épingler le volet').getAttribute('aria-checked')).toBe('false'));
    switchNamed(host, 'Compteur de notifications non lues').click();
    expect(badge.textContent).toBe('3');
    expect(badge.hidden).toBe(false);
  } finally {
    inbox.destroy();
    panel.destroy();
  }
});
