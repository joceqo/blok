import {shellText} from './shell-i18n';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { startOfDay, startOfMonth } from 'date-fns';
import { ArrowLeft, PanelLeftOpen, Plus, Upload, X } from 'lucide-react';
import { CalendarGrid } from './calendar-grid-cn';
import { CalendarEventInspector } from './calendar-event-inspector';
import { MiniCalendar } from './calendarcn/components/mini-calendar';
import googleCalendarIcon from './assets/google-calendar.png';
import { connectGoogleCalendar } from './calendar-sources';
import { CalendarList } from './calendarcn/components/calendar-list';
import { SidebarOverlay } from './calendarcn/components/sidebar-overlay';
import { SidebarProvider } from './calendarcn/components/ui/sidebar';
import { Avatar, AvatarFallback } from './calendarcn/components/ui/avatar';
import { Button } from './calendarcn/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './calendarcn/components/ui/dropdown-menu';
import { CalendarPortalHost } from './calendarcn/portal';
import { mountWorkspaceRail, type CalendarItem } from './calendar-workspace-rail';
import type { CalendarOptions } from './calendar-view';
import type { CalendarEvent } from './calendar-store';
import type { CalendarWorkspaceEntry } from './calendar-workspaces';
import { importCalendarFile } from './calendar-ical';
import { getTimeFormatter, subscribeDisplayPreferences } from './display-preferences';
import './calendarcn/theme.css';
import './calendar-sources.css';
import './calendar-layout.css';

import type { ViewType } from './calendarcn/components/calendar-types';
import { useCalendar } from './calendarcn/components/calendar-provider';

/** Stable list id for a Google calendar: its workspace plus its source key. */
const googleId = (source: {workspaceId: string; key: string}) => 'gcal|' + source.workspaceId + '|' + source.key;

function CalendarDatePicker({onDateSelect}: {onDateSelect: (date: Date) => void}) {
  const {currentDate, visibleDays, view, weekStartsOn, viewSettings} = useCalendar();
  return <MiniCalendar currentDate={currentDate} weekStartsOn={weekStartsOn}
    visibleDays={view === 'day' || view === 'week' ? visibleDays : undefined}
    showWeekNumber={viewSettings.showWeekNumbers} onDateSelect={onDateSelect}/>;
}
interface Selection {
  event: CalendarEvent;
  owner?: CalendarWorkspaceEntry;
  existing: boolean;
  sequence: number;
}
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Le calendrier est indisponible.';

function useHost() {
  return useState(() => document.createElement('div'))[0];
}
function slot(node: HTMLElement) {
  return (parent: HTMLElement | null) => {
    if (parent && node.parentElement !== parent) parent.append(node);
  };
}

export function BlokCalendar({ options, container }: { options: CalendarOptions; container: HTMLElement }) {
  const [date, setDate] = useState(() => startOfDay(new Date()));
  const [view, setView] = useState<ViewType>(() =>
    window.matchMedia?.('(max-width:650px)').matches ? 'day' : 'week',
  );
  const [range, setRange] = useState<{ from: string; to: string }>();
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [selection, select] = useState<Selection>();
  const [preview, setPreview] = useState<CalendarEvent>();
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [moveError, setMoveError] = useState('');
  const [error, setError] = useState('');
  const [narrow, setNarrow] = useState(() => container.clientWidth > 0 && container.clientWidth < 940);
  const [panelPreference, setPanelPreference] = useState<boolean>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const panelOpen = narrow ? sheetOpen : panelPreference !== false;
  const sourcesHost = useHost(),
    panelHost = useHost(),
    portalHost = useHost();
  const sources = useRef<ReturnType<typeof mountWorkspaceRail> | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const seq = useRef(0);
  const hour12 = !!useSyncExternalStore(subscribeDisplayPreferences, getTimeFormatter).resolvedOptions()
    .hour12;
  const changed = useCallback(() => refresh((n) => n + 1), []);
  const rangeChanged = useCallback((from: Date, to: Date) => {
    const a = from.toISOString(),
      b = to.toISOString();
    setRange((prev) => (prev?.from === a && prev.to === b ? prev : { from: a, to: b }));
  }, []);
  useLayoutEffect(() => {
    // The theme and portals follow the workspace, including isolated Storybook documents.
    const theme = container.closest('[data-blok-theme]') ?? document.body;
    portalHost.className = 'blok-calendarcn blok-calendar-portals';
    document.body.append(portalHost);
    const sync = () => {
      const dark = theme.getAttribute('data-blok-theme') === 'dark';
      container.classList.toggle('dark', dark);
      portalHost.classList.toggle('dark', dark);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(theme, { attributes: true, attributeFilter: ['data-blok-theme'] });
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(([entry]) => {
            if (entry && entry.contentRect.width > 0) setNarrow(entry.contentRect.width < 940);
          });
    resize?.observe(container);
    return () => {
      observer.disconnect();
      resize?.disconnect();
      portalHost.remove();
    };
  }, [container, portalHost]);
  useLayoutEffect(() => {
    sourcesHost.className = 'cal-sources';
    const rail = mountWorkspaceRail(sourcesHost, options.store, options.workspaces, changed);
    sources.current = rail;
    return () => {
      rail.destroy();
      sources.current = null;
    };
  }, [sourcesHost, options, changed]);
  useEffect(() => {
    if (!range || !sources.current) return;
    let live = true;
    setLoading(true);
    const visible = options.workspaces
      ?.entries()
      .filter((entry) => entry.connected && entry.visible)
      .map((entry) => entry.id);
    if (visible)
      setItems((current) => current.filter((item) => !item.owner || visible.includes(item.owner.id)));
    sources.current
      .list(range.from, range.to)
      .then(
        (result) => {
          if (!live) return;
          setItems(result.items);
          setError(result.failed.length ? 'Agendas indisponibles : ' + result.failed.join(', ') : '');
        },
        (reason) => {
          if (live) {
            setItems([]);
            setError(messageOf(reason));
          }
        },
      )
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [range, revision, options]);
  useEffect(() => {
    setItems([]);
  }, [range]);

  const spaces = options.workspaces?.entries() ?? [];
  const connected = spaces.filter((entry) => entry.connected);
  const activeEntry = connected.find((entry) => entry.id === options.workspaces?.activeId);
  const account = activeEntry?.store.remote?.client.currentSession?.user;
  const profile =
    account?.name || (activeEntry?.ref.kind === 'remote' ? activeEntry.ref.userName : undefined);
  const writable = connected.filter((entry) => entry.canEdit);
  const canCreate = options.workspaces ? writable.length > 0 : options.canEdit;
  const selectedOwner = selection?.owner;
  const owners = useMemo(() => new Map(items.map((item) => [item.event, item.owner])), [items]);
  const ownerOf = (event: CalendarEvent) =>
    event === preview && selection ? selectedOwner : owners.get(event);
  const keyOf = (event: CalendarEvent) => {
    const owner = ownerOf(event);
    return owner ? JSON.stringify([owner.id, event.id]) : event.id;
  };
  const events = useMemo(() => items.map((item) => item.event), [items]);
  const closeEvent = () => {
    select(undefined);
    setPreview(undefined);
    setSheetOpen(false);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    });
  };
  function open(event: CalendarEvent, existing: boolean) {
    if (!existing && !canCreate) return;
    if (event === preview && selection) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const owner = existing
      ? owners.get(event)
      : (writable.find((entry) => entry.visible && entry.id === options.workspaces?.activeId) ??
        writable.find((entry) => entry.visible) ??
        writable[0]);
    select({ event, existing, owner, sequence: ++seq.current });
    setPreview(event);
    setSheetOpen(true);
    setPanelPreference(true);
  }
  function create() {
    const start = new Date(date);
    start.setHours(9, 0, 0, 0);
    open(
      {
        id: crypto.randomUUID(),
        title: '',
        start: start.toISOString(),
        end: new Date(+start + 3600000).toISOString(),
        allDay: false,
        pageId: null,
        revision: 0,
      },
      false,
    );
  }
  async function move(next: CalendarEvent, original: CalendarEvent) {
    const owner = ownerOf(original);
    if (original.readOnly || original.source || !(owner?.canEdit ?? options.canEdit)) return;
    setMoveError('');
    try {
      await (owner?.store ?? options.store).save(next);
      if (selection?.existing && selection.sequence === seq.current &&
          selection.event.id === original.id && selection.owner?.id === owner?.id) closeEvent();
      changed();
    } catch (reason) {
      changed();
      setMoveError(messageOf(reason));
    }
  }
  function togglePanel() {
    if (selection) {
      closeEvent();
      return;
    }
    if (narrow) setSheetOpen(!panelOpen);
    else setPanelPreference(!panelOpen);
  }
  const actions = (
    <>
      {options.onToggleSidebar && (
        <Button
          variant="ghost"
          size="icon-sm"
          data-desktop-sidebar-toggle=""
          aria-label={shellText("Afficher la barre latérale")}
          onClick={options.onToggleSidebar}
        >
          <PanelLeftOpen />
        </Button>
      )}
      {canCreate && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={shellText("Nouvel événement")}
          title={shellText("Nouvel événement")}
          onClick={create}
        >
          <Plus />
        </Button>
      )}
      {profile && (
        <Avatar size="sm" role="img" aria-label={profile} title={profile}>
          <AvatarFallback>{Array.from(profile.trim())[0]?.toLocaleUpperCase()}</AvatarFallback>
        </Avatar>
      )}
    </>
  );
  const [sourceMessage, setSourceMessage] = useState('');
  const [updatingSource, setUpdatingSource] = useState(false);
  async function updateSources(operation: () => Promise<void>) {
    setSourceMessage('');
    setUpdatingSource(true);
    try {
      await operation();
    } catch (error) {
      setSourceMessage(messageOf(error));
    } finally {
      setUpdatingSource(false);
      changed();
    }
  }
  async function showSpace(entry: CalendarWorkspaceEntry) {
    if (entry.connected) await options.workspaces!.setVisible(entry.id, true);
    else await options.workspaces!.connect(entry.id);
  }
  // Recomputed on every `changed()` — connecting an account or toggling a
  // calendar bumps the revision.
  const googleSources = useMemo(() => sources.current?.googleSources() ?? [], [revision, spaces]);
  const googleTargets = spaces.filter(entry => entry.canEdit && entry.store.remote);
  async function openGoogle(entry?: CalendarWorkspaceEntry) {
    const remote = entry?.store.remote ?? (!options.workspaces && options.store.remote);
    if (!remote) {
      setSourceMessage('Pour connecter Google Agenda, ouvrez un espace Blok relié à un serveur configuré pour Google.');
      return;
    }
    const status = await remote.client.request<{configured:boolean; connected:boolean}>(remote.base + '/google/status');
    if (!status.connected && !status.configured) {
      setSourceMessage('La connexion Google Agenda doit être configurée sur le serveur de cet espace.');
      return;
    }
    if (entry && !entry.visible) await showSpace(entry);
    if (!status.connected) await connectGoogleCalendar(remote);
    else if (entry) sources.current?.openSources(entry.id);
  }
  const googleLabel = <><img width="18" height="18" alt="" src={googleCalendarIcon} />{shellText("Connecter Google Agenda")}</>;
  const defaultPanel = (
    <>
      <CalendarDatePicker
        onDateSelect={(next) => {
          setDate(view === 'month' ? startOfMonth(next) : next);
          setSheetOpen(false);
        }}
      />
      {spaces.length > 0 && (
        <SidebarProvider className="min-h-0 flex-col" keyboardShortcut={false}>
          <CalendarList
            calendars={[
              ...spaces.map((entry) => ({
                id: entry.id,
                name: entry.name,
                color: entry.color as `#${string}`,
                email: entry.ref.kind === 'local' || entry.ref.embedded ? shellText('Sur cet appareil') : entry.ref.userName || new URL(entry.ref.server).host,
              })),
              // A Google account's calendars group under its own address, the
              // shared ones included, each with its own eye.
              ...googleSources.map((source) => ({
                id: googleId(source),
                name: source.label,
                color: source.color as `#${string}`,
                email: source.account,
              })),
            ]}
            hiddenCalendarIds={[
              ...spaces.filter((entry) => !entry.visible).map((entry) => entry.id),
              ...googleSources.filter((source) => !source.visible).map(googleId),
            ]}
            onHiddenCalendarIdsChange={(hidden) => {
              const source = googleSources.find((candidate) => candidate.visible === hidden.includes(googleId(candidate)));
              if (source) {
                sources.current?.setSourceVisible(source.workspaceId, source.key, !source.visible);
                return;
              }
              const entry = spaces.find(e => e.visible === hidden.includes(e.id));
              if (entry && !updatingSource) void updateSources(() =>
                entry.visible ? options.workspaces!.setVisible(entry.id, false) : showSpace(entry));
            }}
          />
        </SidebarProvider>
      )}
      <div className="blok-calendar-account-actions">
        {spaces.some(entry => !entry.visible) && (
          <Button variant="ghost" size="sm" disabled={updatingSource} onClick={() => void updateSources(async () => {
            for (const entry of spaces) if (!entry.visible) await showSpace(entry);
          })}>{shellText("Afficher tous mes espaces")}</Button>
        )}
        {options.workspaces?.unavailable?.().map(ref => (
          <Button key={JSON.stringify([ref.kind, ref.id, ref.kind === 'remote' && ref.accountId, ref.kind === 'remote' && ref.server])}
            variant="ghost" size="sm" title={'Ouvrir ' + ref.name}
            onClick={() => container.dispatchEvent(new CustomEvent('blok:desktop-select-workspace', {bubbles:true, detail:ref}))}>
            {ref.name} {shellText("· Compte indisponible")} </Button>
        ))}
        {googleTargets.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" disabled={updatingSource} />}>{googleLabel}</DropdownMenuTrigger>
            <DropdownMenuContent>
              {googleTargets.map(entry => <DropdownMenuItem key={entry.id} onClick={() => void updateSources(() => openGoogle(entry))}>
                {entry.name}{entry.ref.kind === 'remote' && entry.ref.userName ? ' · ' + entry.ref.userName : ''}
              </DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : <Button variant="ghost" size="sm" disabled={updatingSource}
            onClick={() => void updateSources(() => openGoogle(googleTargets[0]))}>{googleLabel}</Button>}
        {sourceMessage && <small role="status">{sourceMessage}</small>}
      </div>
      <details className="blok-calendar-sources" open={!options.workspaces || undefined}>
        <summary>{shellText("Sources et espaces")}</summary>
        <div ref={slot(sourcesHost)} />
      </details>
      <div className="blok-calendar-panel-actions">
        {canCreate &&
          (writable.length <= 1 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => importCalendarFile(container, writable[0]?.store ?? options.store, changed)}
            >
              <Upload />
              {shellText("Importer un .ics")}
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
                <Upload />
                {shellText("Importer un .ics")}
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {writable.map((entry) => (
                  <DropdownMenuItem
                    key={entry.id}
                    onClick={() => importCalendarFile(container, entry.store, changed)}
                  >
                    {entry.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ))}
        <Button variant="ghost" size="sm" onClick={options.onClose}>
          <ArrowLeft />
          {shellText("Retour à la page")}
        </Button>
      </div>
    </>
  );
  const inspector = selection && (
    <CalendarEventInspector
      key={selection.sequence}
      options={options}
      event={selection.event}
      existing={selection.existing}
      owner={selection.owner}
      autoFocusTitle={!narrow}
      onClose={closeEvent}
      onChanged={changed}
      onPreview={setPreview}
    />
  );
  useEffect(() => {
    if (
      selectedOwner &&
      !options.workspaces?.entries().some((e) => e.id === selectedOwner.id && e.connected && e.visible)
    ) {
      select(undefined);
      setPreview(undefined);
      setSheetOpen(false);
    }
  }, [revision, selectedOwner, options]);
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        e.shiftKey ||
        selection ||
        !canCreate
      )
        return;
      if (
        e.target instanceof Element &&
        (e.target.closest('input,textarea,select,[contenteditable=true],[role=dialog]') ||
          (e.target !== document.body && !container.contains(e.target)))
      )
        return;
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        create();
      }
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  });
  return (
    <CalendarPortalHost.Provider value={portalHost}>
      {(error || moveError) && (
        <div role="alert" className="blok-calendar-error">
          {moveError || error}{' '}
          <button
            onClick={() => {
              setMoveError('');
              changed();
            }}
          >
            {shellText("Actualiser")}
          </button>
        </div>
      )}
      <CalendarGrid
        date={date}
        view={view}
        events={events}
        keyOf={keyOf}
        ownerOf={ownerOf}
        canEdit={(e) => !e.readOnly && !e.source && (ownerOf(e)?.canEdit ?? options.canEdit)}
        canCreate={canCreate}
        hour12={hour12}
        loading={loading}
        onOpen={open}
        onMove={move}
        onNavigate={(next, mode) => {
          setDate(next);
          setView(mode);
        }}
        preview={preview}
        selectedId={
          selection ? (selection.existing ? keyOf(preview ?? selection.event) : selection.event.id) : null
        }
        onDeselect={selection ? closeEvent : undefined}
        onVisibleRangeChange={rangeChanged}
        headerActions={actions}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
      >
        {createPortal(<div className="blok-calendar-panel-body">{inspector ?? defaultPanel}</div>, panelHost)}
        {narrow ? (
          <SidebarOverlay
            open={panelOpen}
            onOpenChange={(open) => {
              if (!open && selection) closeEvent();
              else setSheetOpen(open);
            }}
            side="right"
            title={selection ? shellText("Événement") : shellText("Agendas")}
            description={shellText("Détails du calendrier")}
            style={{ '--sidebar-width': '310px' } as CSSProperties}
          >
            {!selection && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={shellText("Fermer les agendas")}
                onClick={() => setSheetOpen(false)}
              >
                <X />
              </Button>
            )}
            <div ref={slot(panelHost)} className="min-h-0 overflow-auto" />
          </SidebarOverlay>
        ) : (
          panelOpen && (
            <aside
              className="blok-calendar-panel"
              aria-label={selection ? shellText("Événement") : shellText("Agendas")}
              ref={slot(panelHost)}
            />
          )
        )}
      </CalendarGrid>
    </CalendarPortalHost.Provider>
  );
}
