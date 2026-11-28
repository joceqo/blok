import {afterEach, expect, it, vi} from 'vitest';
import {createSidebarPreferences} from '../../src/shell/sidebar-preferences';
import {createNotificationTrigger} from './cloud/notification-trigger';
import {readEmailNotification, setEmailNotification} from './cloud/email-notification-preferences';
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
  const sidebar = createSidebarPreferences('atelier', true, ['customize', 'invite']);
  const host = document.createElement('div');
  document.body.append(host);
  const panel = mountShellNavigationSettings(host, {kind: 'sidebar', sidebar});
  try {
    expect(switchNamed(host, 'Événements à venir').getAttribute('aria-checked')).toBe('false');
    switchNamed(host, 'Favoris').click();
    expect(sidebar.getSnapshot().favorites).toBe(false);
    sidebar.set('events', true);
    await vi.waitFor(() => expect(switchNamed(host, 'Événements à venir').getAttribute('aria-checked')).toBe('true'));
    switchNamed(host, 'Personnaliser la barre latérale').click();
    expect(createSidebarPreferences('atelier', true).getSnapshot()).toMatchObject({events: true, favorites: false, customize: false, invite:true});
    expect(createSidebarPreferences('autre', true).getSnapshot().customize).toBe(true);
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

it('offers the four e-mail notification switches, all off until asked, and follows a choice made elsewhere', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const panel = mountShellNavigationSettings(host, {kind: 'notifications'});
  try {
    expect(switchNamed(host, 'Toujours envoyer des notifications par e-mail').getAttribute('aria-checked')).toBe('false');
    expect(switchNamed(host, 'Activité dans mon espace de travail').getAttribute('aria-checked')).toBe('false');
    expect(switchNamed(host, 'Modifications de pages').getAttribute('aria-checked')).toBe('false');
    expect(switchNamed(host, 'Récapitulatif des activités de l’espace de travail').getAttribute('aria-checked')).toBe('false');
    // Off by default, so a click is what asks for the mail.
    switchNamed(host, 'Modifications de pages').click();
    expect(readEmailNotification('pageUpdates')).toBe(true);
    await vi.waitFor(() => expect(switchNamed(host, 'Modifications de pages').getAttribute('aria-checked')).toBe('true'));
    setEmailNotification('digest', true);
    await vi.waitFor(() => expect(switchNamed(host, 'Récapitulatif des activités de l’espace de travail').getAttribute('aria-checked')).toBe('true'));
  } finally { panel.destroy(); }
});
