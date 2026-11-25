import {afterEach,expect,it,vi} from 'vitest';
import {mountShellNavigationSettings} from '../shell-navigation-settings';
import {readInboxPreference,setInboxPreference} from './inbox-preferences';
import {discussionAlerts} from './system-notifications';
import type {WorkspaceNotification} from './notifications-api';

afterEach(() => {localStorage.clear(); vi.unstubAllGlobals(); document.body.replaceChildren();});

function browser(permission: NotificationPermission) {
  const posted: string[] = [];
  class BrowserNotice {
    static permission = permission;
    static requestPermission = vi.fn(async () => BrowserNotice.permission);
    constructor(_title: string, options: NotificationOptions) {posted.push(options.body!);}
  }
  vi.stubGlobal('isSecureContext',true);
  vi.stubGlobal('Notification',BrowserNotice);
  return {posted, BrowserNotice};
}

it('asks only after a gesture, honors a denial, and sends a test without enabling discussion alerts', async () => {
  const {posted,BrowserNotice} = browser('default');
  const host = document.createElement('div');
  document.body.append(host);
  const panel = mountShellNavigationSettings(host,{kind:'notifications'});
  try {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Envoyer une notification test')!;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(BrowserNotice.requestPermission).not.toHaveBeenCalled();
    BrowserNotice.requestPermission.mockResolvedValueOnce('denied');
    button.click();
    await vi.waitFor(() => expect(host.querySelector('[role=status]')?.textContent).toContain('bloquées'));
    expect(posted).toEqual([]);
    BrowserNotice.permission = 'granted';
    button.click();
    await vi.waitFor(() => expect(posted.length).toBe(1));
    expect(readInboxPreference('comments')).toBe(false);
    host.querySelector<HTMLButtonElement>('[role=switch]')!.click();
    await vi.waitFor(() => expect(readInboxPreference('comments')).toBe(true));
  } finally {panel.destroy();}
});

it('alerts for new unread discussions once, skips history, read notices and access requests', async () => {
  const {posted,BrowserNotice} = browser('granted');
  setInboxPreference('comments',true);
  const notify = discussionAlerts();
  const signal = new AbortController().signal;
  const item = (id:string, type:WorkspaceNotification['type'], readAt:string|null=null): WorkspaceNotification => ({
    id,type,actorName:'',createdAt:'2026-11-25T10:'+id+':00Z',readAt,
  });
  const old=item('01','comment_mention'), mention=item('02','comment_mention'), reply=item('03','comment_reply'),
    joined=item('04','join_requested'), read=item('05','comment_reply','2026-11-25T11:00:00Z');
  notify([old],signal);
  notify([old,mention,reply,joined,read],signal);
  await vi.waitFor(() => expect(posted.length).toBe(2));
  notify([old,mention,reply,joined,read],signal);
  setInboxPreference('comments',false);
  notify([item('06','comment_mention')],signal);
  setInboxPreference('comments',true);
  BrowserNotice.permission='denied';
  notify([item('07','comment_reply')],signal);
  await Promise.resolve();
  expect(posted.length).toBe(2);
  expect(BrowserNotice.requestPermission).not.toHaveBeenCalled();
});
