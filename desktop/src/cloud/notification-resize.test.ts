import {afterEach, expect, it, vi} from 'vitest';
import {must} from '../test-helpers';
import {createNotificationTrigger} from './notification-trigger';

const storageKey = 'blok:desktop:inbox-width:v1';

function mountSheet() {
  const sidebar = document.createElement('aside');
  sidebar.setAttribute('data-blok-sidebar', '');
  vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 260, 740));
  const inbox = createNotificationTrigger({slug:'atelier', client:{request:vi.fn().mockResolvedValue({notifications:[], unreadCount:0})}});
  const shell = document.createElement('div');
  sidebar.append(inbox.element);
  shell.append(sidebar);
  document.body.append(shell);
  inbox.element.click();
  const edge = () => must(shell.querySelector<HTMLElement>('[data-inbox-resize]'));
  const width = () => Number(edge().getAttribute('aria-valuenow'));
  const press = (key: string) => edge().dispatchEvent(new KeyboardEvent('keydown', {key}));
  const pin = () => must(shell.querySelector<HTMLButtonElement>('[data-inbox-pin]')).click();
  return {inbox, edge, width, press, pin, destroy() { inbox.destroy(); shell.remove(); }};
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(storageKey);
  localStorage.removeItem('blok:desktop:inbox-pinned:v1');
  document.documentElement.removeAttribute('data-inbox-preview-width');
});

it('remembers a keyboard resize across remounts and restores the preferred width after temporary constraints', () => {
  const viewport = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
  let view = mountSheet();
  try {
    expect(view.width()).toBe(390);
    view.press('ArrowLeft');
    expect(view.width()).toBe(374);
    view.press('Home');
    expect(view.width()).toBe(320);
    view.press('End');
    expect(view.width()).toBe(960);
    view.pin();
    viewport.mockReturnValue(1200);
    window.dispatchEvent(new Event('resize'));
    expect(view.width()).toBe(620); // Leave 320px of the page accessible beside the pinned overlay.
    expect(localStorage.getItem(storageKey)).toBe('960');
    view.pin();
    expect(view.width()).toBe(940);
    viewport.mockReturnValue(390);
    window.dispatchEvent(new Event('resize'));
    expect(view.edge().hidden).toBe(true);
    expect(view.width()).toBe(390);
    viewport.mockReturnValue(1600);
    window.dispatchEvent(new Event('resize'));
    expect(view.edge().hidden).toBe(false);
    expect(view.width()).toBe(960);
    view.press('Enter');
    expect(document.activeElement).toBe(view.inbox.element);
    view.inbox.element.click();
    expect(view.width()).toBe(960);
    view.destroy();
    view = mountSheet();
    expect(view.width()).toBe(960);
  } finally { view.destroy(); }
});

it('commits the width at the end of a drag and discards a cancelled gesture', () => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
  const view = mountSheet();
  const edge = view.edge();
  edge.setPointerCapture = vi.fn();
  const pointer = (type: string, clientX: number) => edge.dispatchEvent(new PointerEvent(type, {pointerId:2, clientX}));
  try {
    pointer('pointerdown', 650);
    pointer('pointermove', 820);
    expect(view.width()).toBe(560);
    expect(localStorage.getItem(storageKey)).toBeNull();
    pointer('pointerup', 820);
    expect(localStorage.getItem(storageKey)).toBe('560');
    pointer('pointerdown', 820);
    pointer('pointermove', 720);
    pointer('pointercancel', 720);
    expect(view.width()).toBe(560);
    expect(localStorage.getItem(storageKey)).toBe('560');
    pointer('pointerdown', 820);
    pointer('pointerup', 820);
    expect(view.inbox.element.getAttribute('aria-expanded')).toBe('false');
  } finally { view.destroy(); }
});

it('opens with a valid width after a damaged preference and can resize with storage blocked', () => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
  localStorage.setItem(storageKey, '999999999');
  const view = mountSheet();
  try {
    expect(view.width()).toBe(390);
    const unavailable = () => { throw new Error('Storage unavailable'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(unavailable);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(unavailable);
    view.press('ArrowRight');
    expect(view.width()).toBe(406);
    view.press('Enter');
    view.inbox.element.click();
    expect(view.width()).toBe(406);
  } finally { view.destroy(); }
});

it('keeps a live preview width independent of the visitor’s persistent choice', () => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
  localStorage.setItem(storageKey, '722');
  document.documentElement.setAttribute('data-inbox-preview-width', '570');
  const view = mountSheet();
  try {
    expect(view.width()).toBe(570);
    view.press('ArrowRight');
    view.press('Enter');
    view.inbox.element.click();
    expect(view.width()).toBe(586);
    expect(localStorage.getItem(storageKey)).toBe('722');
  } finally { view.destroy(); }
});
