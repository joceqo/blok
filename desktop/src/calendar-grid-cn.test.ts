import {act, createElement, useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {CalendarGrid, type CalendarGridProps} from './calendar-grid-cn';
import {useCalendar, useCalendarViewSync} from './calendarcn/components/calendar-provider';
import type {CalendarEvent} from './calendar-store';

const stored: CalendarEvent = {id:'event', title:'Revue', start:'2026-03-28', end:'2026-03-31', allDay:true, pageId:'page', revision:8};
const date = new Date(2026, 2, 28);
const source = {...stored, title:'Externes', source:{id:'feed', label:'Externes', color:'#408242'}};

function renderGrid(overrides: Partial<CalendarGridProps> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let api: ReturnType<typeof useCalendar>;
  let viewApi: ReturnType<typeof useCalendarViewSync>;
  function Probe() {
    const calendar = useCalendar();
    const sync = useCalendarViewSync();
    useLayoutEffect(() => { api = calendar; viewApi = sync; });
    return null;
  }
  const props: CalendarGridProps = {
    date, view:'agenda', events:[stored, source], keyOf:event => event.source ? 'external/event' : 'work/event',
    ownerOf:() => undefined, canEdit:() => true, canCreate:true, hour12:false, loading:false,
    onOpen:vi.fn(), onMove:vi.fn(), onNavigate:vi.fn(), onVisibleRangeChange:vi.fn(), onDeselect:vi.fn(), ...overrides,
  };
  function paint(selectedId?: string | null) {
    act(() => root.render(createElement(CalendarGrid, {...props, selectedId}, createElement(Probe))));
  }
  paint();
  cleanups.push(() => { act(() => root.unmount()); container.remove(); });
  return {api:() => api, sync:() => viewApi, props, container, paint};
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  for (const name of ['scrollTo', 'scrollIntoView']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, {value:vi.fn(), configurable:true});
    cleanups.push(() => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
  }
});
afterEach(() => { while (cleanups.length) cleanups.pop()!(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('opens the correct workspace event and forwards only a writable move with its stored revision', () => {
  const {api, props, container, paint} = renderGrid();
  act(() => container.querySelector<HTMLElement>('[data-event-id="external/event"]')!.click());
  expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(source, true);
  paint('external/event');
  act(() => { const item = api().events[1]!; api().updateEvent({...item, end:new Date(2026, 3, 1)}); });
  expect(props.onMove).not.toHaveBeenCalled();
  act(() => { const item = api().events[0]!; api().updateEvent({...item, end:new Date(2026, 3, 1)}); });
  expect(props.onMove).toHaveBeenCalledExactlyOnceWith({...stored, end:'2026-04-02'}, stored);
  paint(null);
  expect(api().selectedEventId).toBeNull();
  expect(props.onOpen).toHaveBeenCalledTimes(1);
});

it('opens the inspector with the final drawn range on release, without writing a draft', () => {
  const {sync, props} = renderGrid();
  const range = {start:date, end:date, isAllDay:true};
  act(() => sync().drawEventDraft(range, 'start'));
  expect(props.onOpen).not.toHaveBeenCalled();
  act(() => sync().drawEventDraft({...range, end:new Date(2026, 2, 30)}, 'end'));
  expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({start:'2026-03-28', end:'2026-03-31', revision:0}), false);
  expect(props.onMove).not.toHaveBeenCalled();
});

it('scopes Command-K to the calendar and opens the workspace event selected from the palette', async () => {
  const {container, props} = renderGrid();
  const outside = document.createElement('button');
  document.body.append(outside);
  cleanups.push(() => outside.remove());
  const shortcut = () => new KeyboardEvent('keydown', {key:'k', metaKey:true, bubbles:true, cancelable:true});
  const outsidePress = shortcut();
  act(() => outside.dispatchEvent(outsidePress));
  expect(outsidePress.defaultPrevented).toBe(false);
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Rechercher dans le calendrier"]')!;
  const insidePress = shortcut();
  await act(async () => { trigger.dispatchEvent(insidePress); });
  expect(insidePress.defaultPrevented).toBe(true);
  const menu = document.querySelector<HTMLElement>('[cmdk-root]')!;
  const event = Array.from(menu.querySelectorAll<HTMLElement>('[cmdk-item]')).find(item => item.textContent?.includes('Externes'));
  expect(event).toBeDefined();
  await act(async () => { event!.click(); });
  expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(source, true);
});
