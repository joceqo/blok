import {useEffect, useRef, useState} from 'react';
import {CalendarDays, Check, ChevronDown, Download, ExternalLink, FileText, Users, Trash2, X} from 'lucide-react';
import {EventDetailPanel} from './calendarcn/components/event-detail-panel';
import {Button} from './calendarcn/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuTrigger,
} from './calendarcn/components/ui/dropdown-menu';
import {fromCalendarCN, toCalendarCN} from './calendar-cn-event';
import {exportCalendarEvent} from './calendar-ical';
import type {CalendarEvent} from './calendar-store';
import type {CalendarOptions} from './calendar-view';
import type {CalendarWorkspaceEntry} from './calendar-workspaces';

interface InspectorProps {
  options: CalendarOptions;
  event: CalendarEvent;
  existing: boolean;
  autoFocusTitle?: boolean;
  owner?: CalendarWorkspaceEntry;
  onClose(): void;
  onChanged(): void;
  onPreview?(event: CalendarEvent): void;
}

interface Choice {id: string; title: string}

function FieldMenu({label, value, items, onChange}: {
  label: string;
  value: string;
  items: Choice[];
  onChange?: (id: string) => void;
}) {
  const title = items.find(item => item.id === value)?.title;
  return <div className="flex min-w-0 flex-1 items-center">
    {onChange ? <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" aria-label={label}
        className="min-w-0 justify-start gap-2 px-2 font-normal"/>}>
        <span className="truncate">{title}</span><ChevronDown className="size-3 shrink-0"/>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={label} className="max-h-64 overflow-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {items.map(item => <DropdownMenuRadioItem key={item.id} value={item.id}>{item.title}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu> : <span className="truncate px-2 text-sm" aria-label={label}>{title}</span>}
  </div>;
}

/** One session per selection. A draft, including its revision, is private to this
 * inspector until the user confirms. The provider can paint the preview in the grid. */
export function CalendarEventInspector({options, event, existing, owner, onClose, onChanged, onPreview, autoFocusTitle = true}: InspectorProps) {
  const spaces = options.workspaces;
  const writable = spaces?.entries().filter(item => item.connected && item.canEdit) ?? [];
  const preferred = owner ?? writable.find(item => item.visible && item.id === spaces?.activeId) ??
    writable.find(item => item.visible) ?? writable[0];
  const [target, setTarget] = useState(preferred?.id);
  const destination = spaces?.entries().find(item => item.id === target && item.connected);
  const editable = !event.source && !event.readOnly && (spaces ? Boolean(destination?.canEdit) : options.canEdit);
  const [current, setCurrent] = useState(() => toCalendarCN(event, event.id, preferred?.id));
  const [pageId, setPageId] = useState(event.pageId);
  const [participantIds, setParticipantIds] = useState(event.participantIds);
  const remote = (destination?.store ?? options.store).remote;
  const [directory, setDirectory] = useState<{key:string; members:Choice[]; failed?:boolean}>();
  useEffect(() => {
    if (!remote || event.source) return;
    const controller = new AbortController();
    void remote.client.request<{members:Choice[]}>(
      remote.base + '/invitees', {signal:controller.signal},
    ).then(({members}) => {
      if (!controller.signal.aborted) setDirectory({key:remote.preferenceKey,members});
    }).catch(() => {
      if (!controller.signal.aborted) setDirectory({key:remote.preferenceKey,members:[],failed:true});
    });
    return () => controller.abort();
  }, [remote, event.source]);
  const members = directory?.key === remote?.preferenceKey ? directory?.members : undefined;
  const draft = {...fromCalendarCN(current, event), pageId, participantIds};
  const inviting = participantIds?.some(id => !event.participantIds?.includes(id));
  const [extraPages, setExtraPages] = useState<{id:string; pages:Choice[]; failed?:boolean}>();
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!spaces || !target || target === spaces.activeId) return;
    let selected = true;
    void spaces.pages(target).then(
      pages => { if (selected) setExtraPages({id:target, pages}); },
      () => { if (selected) setExtraPages({id:target, pages:[], failed:true}); },
    );
    return () => { selected = false; };
  }, [spaces, target]);
  const localPages = !spaces || target === spaces.activeId;
  const pages = localPages ? options.pages : extraPages?.id === target ? extraPages.pages : [];
  const knownPage = draft.pageId && pages.some(item => item.id === draft.pageId);
  const pageItems = [{id:'',title:'Aucune page'}, ...pages.map(item => ({id:item.id, title:item.title || 'Sans titre'}))];
  if (draft.pageId && !knownPage) pageItems.push({id:draft.pageId,title:'Page liée'});

  function edit(next: typeof current, nextPage = pageId) {
    if (!editable || inFlight.current) return;
    setCurrent(next);
    setPageId(nextPage);
    onPreview?.({...fromCalendarCN(next, event), pageId:nextPage});
  }

  async function persist(remove: boolean) {
    if (!editable || inFlight.current) return;
    const workspace = spaces?.entries().find(item => item.id === target && item.connected && item.canEdit);
    if (spaces && !workspace) { setError('Cet agenda n’est plus accessible en écriture.'); return; }
    const title = draft.title.trim();
    if (!remove && !title) { setError('Saisissez un titre.'); return; }
    if (!remove && title.length > 200) { setError('Le titre est limité à 200 caractères.'); return; }
    if (!remove && !(Date.parse(draft.end) > Date.parse(draft.start))) { setError('La fin doit être après le début.'); return; }
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const store = workspace?.store ?? options.store;
      if (remove) await store.remove(event);
      else await store.save({...draft, title});
      if (alive.current) onClose();
      onChanged();
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : 'Impossible d’enregistrer cette modification.');
    } finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  }

  const heading = existing ? 'Événement' : 'Nouvel événement';
  const update = editable && !pending ? (next: typeof current) => edit(next) : undefined;
  const roomLabel = event.source?.label ?? destination?.name;
  const canChooseSpace = editable && !existing && writable.length > 1 && !pending;

  return <section aria-label={heading} data-calendar-event-inspector="" aria-busy={pending}
    className="min-w-0 pb-4 text-calendar-detail-foreground"
    onKeyDown={e => {
      if (e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing && !pending) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }}>
    <EventDetailPanel event={current} onEventChange={update} onTitlePreview={update}
      autoFocusTitle={autoFocusTitle && !existing && editable} basicFields={{heading, titleLabel:'Titre de l’événement', allDayLabel:'Toute la journée'}}
      headerActions={<Button type="button" size="icon" variant="ghost" className="size-7"
        disabled={pending} aria-label="Fermer la fiche" onClick={onClose}><X className="size-4"/></Button>}/>
    <div className="space-y-1 border-b border-calendar-sidebar-border px-3 py-2">
      {roomLabel && <div className="flex min-h-8 items-center gap-2">
        <CalendarDays className="size-4 shrink-0 text-calendar-detail-muted"/>
        <FieldMenu label="Agenda" value={target ?? ''} items={canChooseSpace
          ? writable.map(item => ({id:item.id, title:item.name})) : [{id:target ?? '',title:roomLabel}]}
          onChange={canChooseSpace ? id => { setTarget(id); setParticipantIds(undefined); edit({...current, calendarId:id}, null); } : undefined}/>
      </div>}
      {remote && !event.source && <div className="flex min-h-8 items-start gap-2 py-1">
        <Users className="mt-1.5 size-4 shrink-0 text-calendar-detail-muted"/>
        <div className="min-w-0">
          {editable && <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" size="sm" variant="ghost" disabled={pending || !members?.length}/>}>
              Ajouter des participants
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" aria-label="Membres de l’espace" className="max-h-64 overflow-auto">
              {members?.map(member => <DropdownMenuCheckboxItem key={member.id} checked={participantIds?.includes(member.id) ?? false}
                onCheckedChange={checked => setParticipantIds(ids => checked ? [...(ids ?? []),member.id] : ids?.filter(id => id !== member.id))}>
                {member.title}
              </DropdownMenuCheckboxItem>)}
            </DropdownMenuContent>
          </DropdownMenu>}
          {directory?.key === remote.preferenceKey && directory.failed && <p role="status">Liste des membres indisponible.</p>}
          {!!participantIds?.length && <p className="px-2 text-sm" aria-label="Participants">
            {participantIds.map(id => members?.find(member => member.id === id)?.title ?? 'Membre').join(', ')}
          </p>}
        </div>
      </div>}
      {(editable || draft.pageId) && <div className="flex min-h-8 items-center gap-2">
        <FileText className="size-4 shrink-0 text-calendar-detail-muted"/>
        <FieldMenu label="Page Blok associée" value={draft.pageId ?? ''} items={pageItems}
          onChange={editable && !pending && (localPages || (extraPages?.id === target && !extraPages.failed))
            ? id => edit(current, id || null) : undefined}/>
        {knownPage && <Button type="button" size="icon" variant="ghost" className="size-7"
          aria-label="Ouvrir la page" disabled={pending} onClick={() => {
            const id = draft.pageId;
            if (!id) return;
            onClose();
            if (destination && options.openWorkspacePage) options.openWorkspacePage(destination.ref, id);
            else options.openPage(id);
          }}><ExternalLink className="size-4"/></Button>}
      </div>}
      {!localPages && extraPages?.id === target && extraPages?.failed && <p role="status">Pages indisponibles.</p>}
    </div>
    {error && <p role="alert" className="px-3 pt-2 text-sm text-calendar-danger">{error}</p>}
    <div className="flex flex-wrap items-center gap-1 px-3 pt-3">
      {existing && <Button size="icon" type="button" variant="ghost" className="size-7"
        aria-label="Exporter en .ics" title="Exporter en .ics" onClick={() => exportCalendarEvent(event)}><Download className="size-4"/></Button>}
      {existing && editable && <Button size={confirmDelete ? 'sm' : 'icon'} type="button" variant="ghost" disabled={pending}
        className="h-7 text-calendar-danger" aria-label={confirmDelete ? 'Confirmer la suppression' : 'Supprimer'}
        onClick={() => confirmDelete ? void persist(true) : setConfirmDelete(true)}>
        <Trash2 className="size-4"/>{confirmDelete && 'Confirmer la suppression'}
      </Button>}
      {editable && <div className="ml-auto flex gap-1">
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onClose}>Annuler</Button>
        <Button type="button" size="sm" disabled={pending} onClick={() => void persist(false)}>
          <Check className="size-3.5"/>{inviting ? 'Enregistrer et inviter' : 'Enregistrer'}
        </Button>
      </div>}
    </div>
  </section>;
}
