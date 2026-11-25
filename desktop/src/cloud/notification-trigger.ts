import { IconCross, IconMail, IconPin, IconPinFilled } from '../../../src/components/icons';
import { button, el } from '../ui/dom';
import { fetchNotifications, mountNotificationList, type NotificationListOptions } from './notifications';

export function createNotificationTrigger(options: NotificationListOptions) {
  const trigger = el('button', { attrs: { type:'button', 'data-inbox-trigger':'', 'aria-expanded':'false' } });
  const icon = el('span', { attrs: { 'aria-hidden':'true' } });
  icon.innerHTML = IconMail;
  const count = el('span', { attribute: 'data-inbox-count' });
  count.hidden = true;
  trigger.append(icon, el('span', {text: 'Notifications', attribute:'data-inbox-label'}), count);
  const life = new AbortController();
  let timer: number | undefined;
  let pane: { close(restoreFocus?: boolean): void; refresh(): Promise<void> } | undefined;
  let revision = 0;

  function updateCount(value: number): void {
    ++revision;
    count.hidden = !value;
    count.textContent = String(value);
    const label = value ? `Notifications (${value} non lue${value === 1 ? '' : 's'})` : 'Notifications';
    trigger.title = label;
    trigger.setAttribute('aria-label', label);
  }
  updateCount(0);
  async function poll(): Promise<void> {
    if (life.signal.aborted || !trigger.isConnected) return;
    if (!document.hidden) {
      const current = revision;
      try {
        if (pane) await pane.refresh();
        else {
          const result = await fetchNotifications(options, life.signal);
          if (current === revision && !life.signal.aborted) updateCount(result.unreadCount);
        }
      } catch { /* Manual refresh remains available in the pane. */ }
    }
    if (!life.signal.aborted && trigger.isConnected) timer = window.setTimeout(() => { void poll(); }, 60_000);
  }
  timer = window.setTimeout(() => { void poll(); }, 0);

  trigger.addEventListener('click', () => {
    if (pane) { pane.close(true); return; }
    ++revision;
    const sidebar = trigger.closest<HTMLElement>('[data-blok-sidebar]');
    const surface = el('aside', {attrs:{'data-inbox-pane':'', 'aria-label':'Notifications'}});
    surface.id = 'inbox-' + crypto.randomUUID();
    (sidebar ?? trigger).after(surface);
    const listeners = new AbortController();
    const {signal} = listeners;
    let pinned = false;
    const notifications = mountNotificationList(surface, {
      ...options, onUnreadCount: updateCount,
      onManageRequests: options.onManageRequests ? () => { close(true); options.onManageRequests?.(); } : undefined,
    });
    const closeButton = button({label:'Fermer les notifications', attribute:'data-inbox-close', onClick:() => close(true)});
    closeButton.title = 'Fermer les notifications';
    closeButton.setAttribute('aria-label', closeButton.title);
    closeButton.innerHTML = IconCross;
    const pin = button({label:'Épingler le panneau', attribute:'data-inbox-pin', onClick:() => setPinned(!pinned)});
    function setPinned(value: boolean): void {
      pinned = value;
      surface.toggleAttribute('data-pinned', value);
      pin.setAttribute('aria-pressed', String(value));
      pin.title = value ? 'Désépingler le panneau' : 'Épingler le panneau';
      pin.setAttribute('aria-label', pin.title);
      pin.innerHTML = value ? IconPinFilled : IconPin;
    }
    setPinned(false);
    surface.querySelector('header')?.append(pin, closeButton);
    function position(): void {
      const anchor = (sidebar ?? trigger).getBoundingClientRect();
      const roomBeside = sidebar && window.innerWidth - anchor.right >= 380;
      const left = sidebar ? (roomBeside ? anchor.right + 4 : 8) : Math.max(8, Math.min(anchor.left, window.innerWidth - 388));
      const top = sidebar ? anchor.top + 4 : Math.min(anchor.bottom + 4, window.innerHeight * 0.35);
      surface.style.setProperty('--inbox-left', left + 'px');
      surface.style.setProperty('--inbox-top', Math.max(8, top) + 'px');
      surface.style.setProperty('--inbox-bottom', '8px');
      pin.hidden = !sidebar || window.innerWidth < 860 || window.innerWidth - anchor.right < 560;
      if (pin.hidden && pinned) setPinned(false);
    }
    position();
    const observer = sidebar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(position) : undefined;
    if (sidebar) observer?.observe(sidebar);
    window.addEventListener('resize', position, {signal});
    if (!sidebar) window.addEventListener('scroll', position, {capture:true, signal});
    function close(restoreFocus = false): void {
      listeners.abort();
      observer?.disconnect();
      notifications.destroy();
      surface.remove();
      trigger.removeAttribute('aria-controls');
      trigger.setAttribute('aria-expanded', 'false');
      pane = undefined;
      if (restoreFocus && trigger.isConnected) trigger.focus();
    }
    document.addEventListener('pointerdown', event => {
      if (!pinned && !event.composedPath().includes(surface) && !event.composedPath().includes(trigger)) close();
    }, {capture:true, signal});
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!surface.contains(document.activeElement) && document.activeElement !== trigger) return;
      event.preventDefault();
      close(true);
    }, {signal});
    pane = {close, async refresh() {
      if (!surface.contains(document.activeElement)) await notifications.refresh();
    }};
    trigger.setAttribute('aria-controls', surface.id);
    trigger.setAttribute('aria-expanded', 'true');
    closeButton.focus({preventScroll:true});
  });
  return { element: trigger, destroy() { life.abort(); window.clearTimeout(timer); pane?.close(); trigger.remove(); } };
}
