import { IconChevronDoubleRight, IconCross, IconInbox, IconPin, IconPinFilled } from '../../../src/components/icons';
import { button, el } from '../ui/dom';
import { readInboxPreference, setInboxPreference, subscribeInboxPreferences } from './inbox-preferences';
import {discussionAlerts, paintSystemBadge} from './system-notifications';
import { fetchNotifications, mountNotificationList, type NotificationListOptions } from './notifications';

const widthStorageKey = 'blok:desktop:inbox-width:v1';
const minSheetWidth = 320;
const maxSheetWidth = 960;
const minEditorWidth = 320;

function validWidth(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= minSheetWidth && value <= maxSheetWidth ? value : fallback;
}

function readPreferredWidth(fallback: number): number {
  try {
    return validWidth(localStorage.getItem(widthStorageKey), fallback);
  } catch { /* Keep the preference in memory when storage is unavailable. */ }
  return fallback;
}

function attachSheetResize(surface: HTMLElement, slide: HTMLElement, space: HTMLElement, width: {preferred: number; persistent: boolean}, onClose: () => void, signal: AbortSignal) {
  const edge = el('div', {attrs: {
    'data-inbox-resize':'', role:'separator', tabindex:'0', 'aria-orientation':'vertical',
    'aria-controls':surface.id, 'aria-label':'Largeur du volet Notifications',
    title:'Glisser pour redimensionner, cliquer pour fermer',
  }});
  slide.append(edge);
  let min = minSheetWidth;
  let max = maxSheetWidth;
  let current = width.preferred;
  let drag: {id: number; x: number; y: number; startWidth: number; moved: boolean} | undefined;
  function apply(value: number) {
    current = Math.max(min, Math.min(max, Math.round(value)));
    surface.style.setProperty('--inbox-sheet-width', current + 'px');
    space.style.setProperty('--inbox-sheet-width', current + 'px');
    edge.setAttribute('aria-valuenow', String(current));
    edge.setAttribute('aria-valuetext', current + ' pixels');
  }
  function saveWidth() {
    if (min === max || current === width.preferred) return;
    width.preferred = current;
    if (!width.persistent) return;
    try { localStorage.setItem(widthStorageKey, String(current)); } catch { /* Keep this session’s width. */ }
  }
  edge.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    edge.focus({preventScroll:true});
    edge.setPointerCapture(event.pointerId);
    drag = {id:event.pointerId, x:event.clientX, y:event.clientY, startWidth:current, moved:false};
    event.preventDefault();
  }, {signal});
  edge.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.moved = true;
    edge.setAttribute('data-resizing', '');
    apply(drag.startWidth + event.clientX - drag.x);
  }, {signal});
  function endDrag(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return;
    const close = event.type === 'pointerup' && !drag.moved;
    if (drag.moved) {
      if (event.type === 'pointerup') saveWidth();
      else apply(width.preferred);
    }
    drag = undefined;
    edge.removeAttribute('data-resizing');
    if (close) onClose();
  }
  edge.addEventListener('pointerup', endDrag, {signal});
  edge.addEventListener('lostpointercapture', endDrag, {signal});
  edge.addEventListener('pointercancel', endDrag, {signal});
  edge.addEventListener('keydown', event => {
    const previous = current;
    switch (event.key) {
      case 'ArrowLeft': apply(current - 16); break;
      case 'ArrowRight': apply(current + 16); break;
      case 'Home': apply(min); break;
      case 'End': apply(max); break;
      case 'Enter': onClose(); break;
      default: return;
    }
    if (current !== previous) saveWidth();
    event.preventDefault();
  }, {signal});
  return (available: number, pinned: boolean, fullWidth: boolean) => {
    max = fullWidth ? available : Math.min(maxSheetWidth, available - (pinned ? minEditorWidth : 0));
    min = fullWidth ? available : Math.min(minSheetWidth, max);
    edge.hidden = min === max;
    edge.setAttribute('aria-valuemin', String(min));
    edge.setAttribute('aria-valuemax', String(max));
    apply(drag ? current : width.preferred);
  };
}

export function createNotificationTrigger(options: NotificationListOptions) {
  const trigger = el('button', { attrs: { type:'button', 'data-inbox-trigger':'', 'aria-expanded':'false' } });
  const icon = el('span', { attrs: { 'aria-hidden':'true' } });
  icon.innerHTML = IconInbox;
  const count = el('span', { attribute: 'data-inbox-count' });
  count.hidden = true;
  trigger.append(icon, el('span', {text: 'Notifications', attribute:'data-inbox-label'}), count);
  const life = new AbortController();
  const notify = discussionAlerts();
  let timer: number | undefined;
  let pane: { toggle(): void; destroy(): void; position(): void; refresh(): Promise<void> } | undefined;
  let revision = 0;
  const previewWidth = document.documentElement.getAttribute('data-inbox-preview-width');
  const sheetWidth = {preferred:validWidth(previewWidth, 390), persistent:previewWidth === null};
  let preferPinned = sheetWidth.persistent && readInboxPreference('pinned');
  let unreadCount = 0;

  function paintCount(): void {
    count.hidden = !unreadCount || !readInboxPreference('badge');
    count.textContent = String(unreadCount);
    const label = count.hidden ? 'Notifications' : `Notifications (${unreadCount} non lue${unreadCount === 1 ? '' : 's'})`;
    trigger.title = label;
    trigger.setAttribute('aria-label', label);
  }
  function updateCount(value: number): void {
    ++revision;
    if (unreadCount !== value) paintSystemBadge(value);
    unreadCount = value;
    paintCount();
  }
  let unsubscribe: (() => void) | undefined;
  function watchPreferences(): void {
    if (unsubscribe) return;
    const update = () => {
      if (sheetWidth.persistent) preferPinned = readInboxPreference('pinned');
      paintCount();
      pane?.position();
    };
    unsubscribe = subscribeInboxPreferences(update);
    update();
  }
  function stopWatching(): void {
    unsubscribe?.();
    unsubscribe = undefined;
  }
  life.signal.addEventListener('abort', stopWatching, {once:true});
  paintCount();
  async function poll(): Promise<void> {
    if (life.signal.aborted) return;
    if (!trigger.isConnected) { stopWatching(); return; }
    watchPreferences();
    if (!document.hidden || readInboxPreference('comments')) {
      const current = revision;
      try {
        if (pane && !document.hidden && !readInboxPreference('comments')) await pane.refresh();
        else {
          const result = await fetchNotifications(options, life.signal);
          if (current === revision && !life.signal.aborted) {
            updateCount(result.unreadCount);
            notify(result.notifications, life.signal);
            if (pane && !document.hidden) await pane.refresh();
          }
        }
      } catch { /* Manual refresh remains available in the pane. */ }
    }
    if (!life.signal.aborted) timer = window.setTimeout(() => { void poll(); }, 60_000);
  }
  timer = window.setTimeout(() => { void poll(); }, 0);

  trigger.addEventListener('click', () => {
    watchPreferences();
    if (pane) { pane.toggle(); return; }
    ++revision;
    const sidebar = trigger.closest<HTMLElement>('[data-blok-sidebar]');
    const surface = el('aside', {attrs:{'data-inbox-pane':'', 'aria-label':'Notifications'}});
    surface.toggleAttribute('data-inbox-sheet', Boolean(sidebar));
    surface.id = 'inbox-' + crypto.randomUUID();
    const slide = sidebar ? el('div', {attribute:'data-inbox-slide'}) : null;
    if (slide) surface.append(slide);
    (sidebar ?? trigger).after(surface);
    const listeners = new AbortController();
    const {signal} = listeners;
    let pinned = false;
    const backdrop = sidebar ? el('div', {attribute:'data-inbox-backdrop'}) : null;
    if (backdrop) {
      surface.after(backdrop);
      backdrop.addEventListener('click', () => close(true), {signal});
    }
    const space = sidebar ? el('div', {attrs:{'data-inbox-space':'', 'aria-hidden':'true'}}) : null;
    if (space) surface.after(space);
    const notifications = mountNotificationList(slide ?? surface, {
      ...options, onInboxItems: items => { if (!signal.aborted) notify(items, life.signal); },
      onOpenPage: options.onOpenPage ? id => { close(true); options.onOpenPage?.(id); } : undefined,
      onUnreadCount: value => { if (!signal.aborted) updateCount(value); },
      onManageRequests: options.onManageRequests ? () => { close(true); options.onManageRequests?.(); } : undefined,
    });
    const closeButton = button({label:'Fermer les notifications', attribute:'data-inbox-close', onClick:() => close(true)});
    closeButton.title = 'Fermer les notifications';
    closeButton.setAttribute('aria-label', closeButton.title);
    closeButton.innerHTML = sidebar ? IconChevronDoubleRight : IconCross;
    const pin = button({label:'Épingler le panneau', attribute:'data-inbox-pin', onClick:() => {
      pin.focus({preventScroll:true});
      preferPinned = !pinned;
      if (sheetWidth.persistent) setInboxPreference('pinned', preferPinned);
      else position();
    }});
    if (sidebar && sheetWidth.persistent) sheetWidth.preferred = readPreferredWidth(sheetWidth.preferred);
    const layoutResize = slide && space && attachSheetResize(surface, slide, space, sheetWidth, () => close(true), signal);
    function setPinned(value: boolean): void {
      pinned = value;
      surface.toggleAttribute('data-pinned', value);
      if (backdrop) backdrop.hidden = value;
      pin.setAttribute('aria-pressed', String(value));
      pin.title = value ? 'Désépingler le panneau' : 'Épingler le panneau';
      pin.setAttribute('aria-label', pin.title);
      pin.innerHTML = value ? IconPinFilled : IconPin;
    }
    notifications.actions.append(pin, closeButton);
    function position(): void {
      const anchor = (sidebar ?? trigger).getBoundingClientRect();
      const roomBeside = window.innerWidth - anchor.right >= minSheetWidth;
      const left = sidebar ? (roomBeside ? anchor.right : 0) : Math.max(8, Math.min(anchor.left, window.innerWidth - 388));
      const top = sidebar ? Math.max(0, anchor.top) : Math.min(anchor.bottom + 4, window.innerHeight * 0.35);
      surface.style.setProperty('--inbox-left', left + 'px');
      surface.style.setProperty('--inbox-top', (sidebar ? top : Math.max(8, top)) + 'px');
      surface.style.setProperty('--inbox-bottom', sidebar ? Math.max(0, window.innerHeight - anchor.bottom) + 'px' : '8px');
      if (backdrop) {
        backdrop.style.left = left + 'px';
        backdrop.style.top = top + 'px';
        backdrop.style.bottom = Math.max(0, window.innerHeight - anchor.bottom) + 'px';
      }
      pin.hidden = !sidebar || window.innerWidth < 860 || window.innerWidth - anchor.right < minSheetWidth + minEditorWidth;
      setPinned(!pin.hidden && preferPinned);
      layoutResize?.(Math.floor(window.innerWidth - left), pinned, !roomBeside);
    }
    position();
    const observer = sidebar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(position) : undefined;
    if (sidebar) observer?.observe(sidebar);
    window.addEventListener('resize', position, {signal});
    if (!sidebar) window.addEventListener('scroll', position, {capture:true, signal});
    let closing = false;
    let pendingExit: Animation | undefined;
    function destroy(): void {
      pendingExit = undefined;
      listeners.abort();
      observer?.disconnect();
      backdrop?.remove();
      space?.remove();
      trigger.removeAttribute('aria-controls');
      trigger.setAttribute('aria-expanded', 'false');
      pane = undefined;
      notifications.destroy();
      surface.remove();
    }
    function close(restoreFocus = false): void {
      if (closing) return;
      closing = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus && trigger.isConnected) trigger.focus({preventScroll:true});
      surface.inert = true;
      surface.setAttribute('aria-hidden', 'true');
      surface.setAttribute('data-inbox-closing', '');
      const exit = slide?.getAnimations?.().find(animation => 'transitionProperty' in animation && animation.transitionProperty === 'transform');
      if (!exit) { destroy(); return; }
      pendingExit = exit;
      const finish = () => { if (pendingExit === exit) destroy(); };
      void exit.finished.then(finish, finish);
    }
    document.addEventListener('pointerdown', event => {
      const path = event.composedPath();
      if (!pinned && !path.includes(surface) && !path.includes(trigger) && !(backdrop && path.includes(backdrop))) close();
    }, {capture:true, signal});
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!surface.contains(document.activeElement) && document.activeElement !== trigger) return;
      event.preventDefault();
      close(true);
    }, {signal});
    pane = {destroy, position, toggle() {
      if (!closing) { close(true); return; }
      pendingExit = undefined;
      closing = false;
      surface.removeAttribute('data-inbox-closing');
      surface.removeAttribute('aria-hidden');
      surface.inert = false;
      trigger.setAttribute('aria-expanded', 'true');
      closeButton.focus({preventScroll:true});
    }, async refresh() {
      if (!closing && !surface.contains(document.activeElement)) await notifications.refresh();
    }};
    trigger.setAttribute('aria-controls', surface.id);
    trigger.setAttribute('aria-expanded', 'true');
    if (closeButton.isConnected) {
      closeButton.focus({preventScroll:true});
    } else {
      const openingFocus = document.activeElement;
      void notifications.ready.then(() => {
        if (!signal.aborted && closeButton.isConnected && document.activeElement === openingFocus) {
          closeButton.focus({preventScroll:true});
        }
      });
    }
  });
  return { element: trigger, destroy() { life.abort(); paintSystemBadge(0); window.clearTimeout(timer); pane?.destroy(); trigger.remove(); } };
}
