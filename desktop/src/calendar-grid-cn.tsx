import {shellText, shellLocale} from './shell-i18n';
import {useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {startOfDay, startOfWeek} from 'date-fns';
import {initialCalendarLocale, loadCalendarLocale} from './calendar-locale';
import {CalendarCommands} from './calendar-commands-cn';
import {CalendarHeader} from './calendarcn/components/calendar-header';
import {CalendarProvider, useCalendar, useCalendarEventDraft} from './calendarcn/components/calendar-provider';
import type {DetailedCalendarEvent, ViewType} from './calendarcn/components/calendar-types';
import {TimeGrid} from './calendarcn/components/time-grid';
import {MonthView} from './calendarcn/components/month-view';
import {YearView} from './calendarcn/components/year-view';
import {AgendaView} from './calendarcn/components/agenda-view';
import {TooltipProvider} from './calendarcn/components/ui/tooltip';
import {fromCalendarCN, toCalendarCN} from './calendar-cn-event';
import type {CalendarEvent} from './calendar-store';
import type {CalendarWorkspaceEntry} from './calendar-workspaces';
import {readTimeZone, subscribeDisplayPreferences} from './display-preferences';

export interface CalendarGridProps {
  date: Date;
  view: ViewType;
  events: CalendarEvent[];
  keyOf(event: CalendarEvent): string;
  ownerOf(event: CalendarEvent): CalendarWorkspaceEntry | undefined;
  canEdit(event: CalendarEvent): boolean;
  canCreate: boolean;
  hour12: boolean;
  loading: boolean;
  selectedId?: string | null;
  preview?: CalendarEvent;
  onDeselect?(): void;
  onOpen(event: CalendarEvent, existing: boolean): void;
  onMove(next: CalendarEvent, original: CalendarEvent): void;
  onNavigate(date: Date, view: ViewType): void;
  onVisibleRangeChange?(from: Date, to: Date): void;
  headerActions?: ReactNode;
  panelOpen?: boolean;
  onTogglePanel?(): void;
  children?: ReactNode;
}

type SelectionProps = Pick<CalendarGridProps, 'selectedId' | 'onOpen' | 'onDeselect' | 'preview'>;
function SelectionBridge({selectedId, onOpen, onDeselect, preview, originals}: SelectionProps & {originals: Map<string, CalendarEvent>}) {
  const {selectedEventId, selectEvent, clearSelection} = useCalendar();
  const draft = useCalendarEventDraft();
  const last = useRef<{external: string | null; internal: string | null}>({external: null, internal: null});
  const external = selectedId ?? null;
  useEffect(() => {
    if (draft.isDrawing) return;
    const previous = last.current;
    last.current = {external, internal: selectedEventId};
    if (external !== previous.external && external !== selectedEventId) {
      if (external) selectEvent(external);
      else clearSelection();
      return;
    }
    if (selectedEventId === previous.internal || selectedEventId === external) return;
    if (!selectedEventId) {
      if (previous.internal === external && external !== null) onDeselect?.();
      return;
    }
    const original = originals.get(selectedEventId);
    if (original) onOpen(original, true);
    else if (draft.isDraft && draft.event?.id === selectedEventId) {
      const blank: CalendarEvent = {id: selectedEventId, title: '', start: '', end: '', allDay: false, revision: 0, pageId: null};
      onOpen(fromCalendarCN(draft.event, blank), false);
    }
  }, [external, selectedEventId, selectEvent, clearSelection, originals, draft, onOpen, onDeselect]);

  const lastPreview = useRef<CalendarEvent | undefined>(undefined);
  useEffect(() => {
    if (preview === lastPreview.current) return;
    lastPreview.current = preview;
    if (preview && draft.isDraft && draft.event?.id === preview.id && !draft.isDrawing) {
      draft.updateEventDraft(toCalendarCN(preview));
    }
  }, [preview, draft]);
  return null;
}

export function CalendarGrid(props: CalendarGridProps) {
  const {events, keyOf, ownerOf, date, view, canEdit, canCreate, preview, selectedId} = props;
  const timeZone = useSyncExternalStore(subscribeDisplayPreferences, readTimeZone);
  const [numberOfDays, setNumberOfDays] = useState(7);
  const language = shellLocale();
  const [locale, setLocale] = useState(() => initialCalendarLocale(language));
  useEffect(() => {
    let current = true;
    setLocale(initialCalendarLocale(language));
    loadCalendarLocale(language)?.then(value => { if (current) setLocale(value); }).catch(() => {});
    return () => { current = false; };
  }, [language]);
  const day = date.getTime();
  const periodStart = useMemo(() => view === 'week' && numberOfDays === 7 ? startOfWeek(day, {weekStartsOn: 1}) : startOfDay(day), [view, day, numberOfDays]);
  const originals = useMemo(() => new Map(events.map(event => [keyOf(event), event])), [events, keyOf]);
  const drawnId = useRef<string | null>(null);
  const display = useMemo(() => {
    const result = Array.from(originals, ([id, stored]) => {
      const owner = ownerOf(stored);
      return toCalendarCN(id === selectedId && preview ? preview : stored, id, owner?.id, owner?.color);
    });
    if (preview && selectedId && !originals.has(selectedId) && selectedId !== drawnId.current) {
      result.push(toCalendarCN(preview, selectedId));
    }
    return result;
  }, [originals, ownerOf, selectedId, preview]);

  const navigation = useRef({date, view});
  useEffect(() => { navigation.current = {date, view}; }, [date, view]);
  function navigate(nextDate: Date, nextView: ViewType) {
    navigation.current = {date: nextDate, view: nextView};
    props.onNavigate(nextDate, nextView);
  }
  function eventAt(target: EventTarget) {
    if (!(target instanceof Element)) return;
    const id = target.closest<HTMLElement>('[data-event-id]')?.dataset.eventId;
    return id ? originals.get(id) : undefined;
  }
  function writable(event: CalendarEvent) { return !event.source && canEdit(event); }
  return <TooltipProvider>
    <CalendarProvider<DetailedCalendarEvent> date={periodStart} view={view} events={display} locale={locale} weekStartsOn={1}
      timeZone={timeZone}
      numberOfDays={numberOfDays} onNumberOfDaysChange={setNumberOfDays}
      defaultViewSettings={{showWeekNumbers:true}} hourCycle={props.hour12 ? 12 : 24} loading={props.loading}
      onDateChange={value => navigate(value, navigation.current.view)}
      onViewChange={value => navigate(navigation.current.date, value)}
      onVisibleRangeChange={({start, end}) => props.onVisibleRangeChange?.(start, end)}
      createEvent={range => {
        if (!canCreate) return null;
        const id = crypto.randomUUID();
        drawnId.current = id;
        return {id, title: '', ...range};
      }}
      onEventUpdate={updated => {
        const original = originals.get(updated.id);
        if (!original || !writable(original)) return;
        const before = toCalendarCN(original);
        if (+updated.start === +before.start && +updated.end === +before.end && !!updated.isAllDay === original.allDay) return;
        props.onMove(fromCalendarCN({...updated, title: original.title}, original), original);
      }}>
      <SelectionBridge selectedId={selectedId} preview={preview} originals={originals} onOpen={props.onOpen} onDeselect={props.onDeselect}/>
      <div data-calendar-grid="" className="relative flex h-full min-h-0 min-w-0 flex-1">
        <section aria-label={shellText("Calendrier")} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          <CalendarHeader sidebarOpen={props.panelOpen} onToggleSidebar={props.onTogglePanel} sidebarSide="right">
            <CalendarCommands/>{props.headerActions}
          </CalendarHeader>
          <div className="flex min-h-0 flex-1 flex-col" onPointerDownCapture={e => {
            const event = eventAt(e.target);
            if (event && !writable(event)) e.stopPropagation();
          }} onKeyDownCapture={e => {
            if (!e.altKey || !e.key.startsWith('Arrow')) return;
            const event = eventAt(e.target);
            if (event && !writable(event)) {
              e.preventDefault();
              e.stopPropagation();
            }
          }} onContextMenuCapture={e => {
            const event = eventAt(e.target);
            if (!event) return;
            // The Blok inspector offers the actions backed by this event's store.
            e.preventDefault();
            e.stopPropagation();
            props.onOpen(event, true);
          }}>
            {view === 'agenda' && <AgendaView showEventPopover={false}/>}
            {view === 'month' && <MonthView showEventPopover={false}/>}
            {view === 'year' && <YearView onDayClick={date => navigate(date, 'day')}/>}
            {(view === 'day' || view === 'week') && <TimeGrid view={view} showEventPopover={false} scrollToHour={7}/>}
          </div>
        </section>
        {props.children}
      </div>
    </CalendarProvider>
  </TooltipProvider>;
}
