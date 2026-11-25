import type { CalendarEvent } from './calendar-store';
import { getTimeFormatter } from './display-preferences';

const minutesPerDay = 1440;
const dayIndex = (key: string) => Date.parse(key + 'T00:00:00Z') / 86_400_000;
const dayKey = (d: Date) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const wallMinutes = (d: Date) => d.getHours() * 60 + d.getMinutes();

export interface CalendarSlot { date: string; minutes: number }

export function reschedule(event: CalendarEvent, origin: CalendarSlot, target: CalendarSlot, resize: boolean): CalendarEvent | null {
  const days = dayIndex(target.date) - dayIndex(origin.date);
  if (event.allDay) {
    const start = new Date(event.start + 'T00:00'), end = new Date(event.end + 'T00:00');
    if (!resize) start.setDate(start.getDate() + days);
    end.setDate(end.getDate() + days);
    return end > start ? { ...event, start: dayKey(start), end: dayKey(end) } : null;
  }
  const initial = new Date(resize ? event.end : event.start);
  const moved = new Date(+initial);
  moved.setDate(moved.getDate() + days);
  moved.setMinutes(moved.getMinutes() + target.minutes - origin.minutes);
  const start = resize ? new Date(event.start) : moved;
  const end = resize ? moved : new Date(+moved + Date.parse(event.end) - Date.parse(event.start));
  return end > start ? { ...event, start: start.toISOString(), end: end.toISOString() } : null;
}

function slotAt(board: HTMLElement, x: number, y: number, allDay: boolean): CalendarSlot | null {
  const columns = board.querySelectorAll<HTMLElement>(allDay ? '.cal-all-cell' : '.cal-column');
  for (const column of columns) {
    const box = column.getBoundingClientRect();
    if (!box.height || x < box.left || x >= box.right || (!allDay && (y < box.top || y > box.bottom))) continue;
    return { date: column.dataset.date!, minutes: allDay ? 0 : Math.min(minutesPerDay, Math.max(0,
      Math.round((y - box.top) / box.height * minutesPerDay / 15) * 15)) };
  }
  return null;
}

function preview(board: HTMLElement, event: CalendarEvent) {
  const columns = board.querySelectorAll<HTMLElement>(event.allDay ? '.cal-all-cell' : '.cal-column');
  const format = getTimeFormatter();
  for (const col of columns) {
    const key = col.dataset.date!;
    const chip = document.createElement('div');
    chip.className = 'cal-drag-preview';
    chip.setAttribute('aria-hidden', 'true');
    chip.textContent = event.title;
    if (event.allDay) {
      if (event.start > key || event.end <= key) continue;
    } else {
      const day = new Date(key + 'T00:00'), next = new Date(+day);
      next.setDate(next.getDate() + 1);
      const start = new Date(event.start), end = new Date(event.end);
      if (start >= next || end <= day) continue;
      const top = start <= day ? 0 : wallMinutes(start);
      const bottom = end >= next ? minutesPerDay : wallMinutes(end);
      chip.style.top = top / minutesPerDay * 100 + '%';
      chip.style.height = Math.max(1, bottom - top) / minutesPerDay * 100 + '%';
      chip.textContent = format.format(start) + ' – ' + format.format(end) + ' · ' + event.title;
    }
    col.append(chip);
  }
}

/** A selection can run backwards and cross midnight. All-day ends stay exclusive. */
export function rangeDraft(a: CalendarSlot, b: CalendarSlot, allDay: boolean): CalendarEvent {
  const toDate = (slot: CalendarSlot) => {
    const date = new Date(slot.date + 'T00:00');
    if (!allDay) date.setMinutes(slot.minutes);
    return date;
  };
  const x = toDate(a), y = toDate(b);
  const [start, end] = x < y ? [x, y] : [y, x];
  if (allDay) end.setDate(end.getDate() + 1);
  else if (+start === +end) end.setMinutes(end.getMinutes() + 15);
  return {id:'', title:'Nouvel événement', start:allDay ? dayKey(start) : start.toISOString(),
    end:allDay ? dayKey(end) : end.toISOString(), allDay, pageId:null, revision:0};
}

/** Keep the stored event in place until its versioned write succeeds. */
export function bindCalendarGestures(board: HTMLElement, find: (id: string) => CalendarEvent | undefined, save: (event: CalendarEvent, original: CalendarEvent) => void,
  create?: (from: CalendarSlot, to: CalendarSlot, allDay: boolean) => void, canCreate: () => boolean = () => true) {
  const life = new AbortController();
  let active: AbortController | undefined;
  let suppressClick = false;
  const clear = () => { board.querySelectorAll('.cal-drag-preview').forEach(node => node.remove()); };
  board.addEventListener('pointerdown', down => {
    suppressClick = false;
    if (active || down.button !== 0 || !down.isPrimary) return;
    const target = down.target;
    if (!(target instanceof Element)) return;
    const chip = target.closest<HTMLElement>('[data-editable-event]');
    const event = chip?.dataset.eventId ? find(chip.dataset.eventId) : undefined;
    if (chip && (!event || event.source)) return;
    if (!event && (!create || !canCreate() || down.pointerType === 'touch' || target.closest('button') || !target.matches('.cal-column,.cal-all-cell'))) return;
    const allDay = event?.allDay ?? target.matches('.cal-all-cell');
    const origin = slotAt(board, down.clientX, down.clientY, allDay);
    if (!origin) return;
    active = new AbortController();
    const signal = active.signal, resize = Boolean(target.closest('.cal-resize'));
    let dragged = false, candidate: CalendarEvent | null = null, end: CalendarSlot | null = null;
    function stop() {
      clear(); delete board.dataset.dragging; active?.abort(); active = undefined;
    }
    life.signal.addEventListener('abort', stop, { once: true, signal });
    window.addEventListener('blur', stop, {signal});
    document.addEventListener('keydown', e => { if (e.key === 'Escape') stop(); }, {signal});
    document.addEventListener('pointercancel', e => { if (e.pointerId === down.pointerId) stop(); }, {signal});
    document.addEventListener('pointermove', e => {
      if (e.pointerId !== down.pointerId || (!dragged && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 5)) return;
      e.preventDefault();
      dragged = suppressClick = true; board.dataset.dragging = '';
      end = slotAt(board, e.clientX, e.clientY, allDay);
      candidate = end ? event ? reschedule(event, origin!, end, resize) : rangeDraft(origin!, end, allDay) : null;
      clear();
      if (candidate) preview(board, candidate);
    }, {signal});
    document.addEventListener('pointerup', e => {
      if (e.pointerId !== down.pointerId) return;
      stop();
      if (!dragged || !candidate) return;
      if (!event && end) create?.(origin!, end, allDay);
      else if (event && (candidate.start !== event.start || candidate.end !== event.end)) save(candidate, event);
    }, {signal});
  }, {signal:life.signal});
  board.addEventListener('click', e => {
    if (suppressClick && e.detail > 0) {
      suppressClick = false; e.stopImmediatePropagation(); e.preventDefault();
    }
  }, {capture:true,signal:life.signal});
  return () => life.abort();
}
