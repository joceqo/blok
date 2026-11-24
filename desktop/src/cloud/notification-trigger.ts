import { openModalDialog } from '@blok/modal-dialog';
import { IconCross, IconMail } from '../../../src/components/icons';
import { button, el } from '../ui/dom';
import { fetchNotifications, mountNotificationList, type NotificationListOptions } from './notifications';

export function createNotificationTrigger(options: NotificationListOptions) {
  const trigger = el('button', { attrs: { type:'button', 'data-inbox-trigger':'', 'aria-haspopup':'dialog' } });
  const icon = el('span', { attrs: { 'aria-hidden':'true' } });
  icon.innerHTML = IconMail;
  const count = el('span', { attribute: 'data-inbox-count' });
  count.hidden = true;
  trigger.append(icon, el('span', {text: 'Notifications', attribute:'data-inbox-label'}), count);
  const life = new AbortController();
  let timer: number | undefined;
  let closeDialog: (() => void) | undefined;
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
    if (!document.hidden && !closeDialog) {
      const current = revision;
      try {
        const result = await fetchNotifications(options, life.signal);
        if (current === revision && !life.signal.aborted) updateCount(result.unreadCount);
      } catch { /* The panel reports failures and offers a retry. */ }
    }
    if (!life.signal.aborted && trigger.isConnected) timer = window.setTimeout(() => { void poll(); }, 60_000);
  }
  // The gateway and desktop both construct their DOM before attaching it.
  timer = window.setTimeout(() => { void poll(); }, 0);

  trigger.addEventListener('click', () => {
    if (closeDialog) return;
    ++revision;
    const overlay = el('div', {attribute:'data-desktop-settings-overlay'});
    const surface = el('section', {attribute:'data-inbox-dialog'});
    const close = button({label:'Fermer', attribute:'data-inbox-close', onClick: () => dialog.close()});
    close.setAttribute('aria-label', 'Fermer');
    close.innerHTML = IconCross;
    surface.append(close);
    overlay.append(surface);
    const notifications = mountNotificationList(surface, {
      ...options, onUnreadCount: updateCount,
      onManageRequests: options.onManageRequests ? () => { dialog.close(); options.onManageRequests?.(); } : undefined,
    });
    const dialog = openModalDialog({ content:overlay, surface, label:'Notifications', initialFocus:() => close,
      onDismiss:() => dialog.close(), onClose:() => { notifications.destroy(); closeDialog = undefined; },
    });
    closeDialog = () => dialog.close();
  });
  return { element: trigger, destroy() { life.abort(); window.clearTimeout(timer); closeDialog?.(); trigger.remove(); } };
}
