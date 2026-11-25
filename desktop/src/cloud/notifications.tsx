import {Fragment, createRef, useId, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {IconCheck, IconInbox, IconMail, IconPeople, IconUndo} from '../../../src/components/icons';
import {NotificationHeader, type InboxFilter} from './notification-header';
import {fetchNotifications, readAllNotifications, setNotificationRead, setNotificationArchived, type NotificationListOptions, type WorkspaceNotification} from './notifications-api';
import './notifications.css';

export {fetchNotifications, type NotificationListOptions, type WorkspaceNotification} from './notifications-api';

const dates = new Intl.DateTimeFormat('fr-FR', {dateStyle:'medium', timeStyle:'short'});

function Icon({svg}: {svg: string}) {
  return <span aria-hidden="true" dangerouslySetInnerHTML={{__html:svg.trim().replace(/>\s+</g, '><')}}/>;
}

const shortDay = new Intl.DateTimeFormat('fr-FR', {day:'numeric', month:'short'});
const shortDate = new Intl.DateTimeFormat('fr-FR', {dateStyle:'short'});
const clockTime = new Intl.DateTimeFormat('fr-FR', {hour:'2-digit', minute:'2-digit'});

function dayNumber(date: Date) {
  // Local calendar days have unequal duration at daylight-saving transitions.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function dateGroup(age: number) {
  if (age <= 0) return 'Aujourd’hui';
  if (age === 1) return 'Hier';
  if (age < 7) return 'Ces 7 derniers jours';
  return 'Plus ancien';
}

function WorkspaceTarget({name}: {name: string}) {
  return <strong data-inbox-target=""><Icon svg={IconPeople}/>{name}</strong>;
}

function Description({item}: {item: WorkspaceNotification}) {
  if (item.type === 'comment_mention' || item.type === 'comment_reply') {
    return <>{item.type === 'comment_mention' ? 'Vous avez été mentionné·e dans un commentaire' : 'Votre commentaire a reçu une réponse'} sur <strong>{item.pageTitle || 'une page'}</strong>.</>;
  }
  const target = item.workspaceName && <WorkspaceTarget name={item.workspaceName}/>;
  if (item.type === 'join_requested') {
    return <><strong>{item.actorName || 'Un utilisateur'}</strong> demande à rejoindre {target || 'cet espace'}.</>;
  }
  return <>Votre demande d’accès{target && <> à {target}</>}</>;
}

function Decision({item}: {item: WorkspaceNotification}) {
  if (item.pageId) return null;
  const decision = item.decision;
  if (item.type === 'join_requested' && !decision) {
    return item.requestPending ? <p data-inbox-decision="">En attente de décision</p> : null;
  }
  const approved = decision ? decision.status === 'approved' : item.type === 'join_approved';
  const actor = decision ? (decision.isMe ? 'vous' : decision.actorName) : item.actorName;
  const at = decision?.at ?? item.createdAt;
  return <p data-inbox-decision="">{approved ? 'Approuvée' : 'Refusée'}{actor && <> par {actor}</>} le <time dateTime={at}>{dates.format(new Date(at))}</time></p>;
}

type RowAction = 'read' | 'archive';
type RowActions = {
  onAction: (item: WorkspaceNotification, action: RowAction, row: HTMLLIElement) => Promise<void>;
  onManage?: () => void;
  onOpenPage?: (id: string) => void;
};

function NotificationRow({item, today, onAction, onManage, onOpenPage}: RowActions & {
  item: WorkspaceNotification;
  today: Date;
}) {
  const row = useRef<HTMLLIElement>(null);
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  async function apply(action: RowAction) {
    if (!row.current || saving) return;
    setSaving(true);
    try { await onAction(item, action, row.current); } finally { setSaving(false); }
  }
  const created = new Date(item.createdAt);
  const format = dayNumber(created) === dayNumber(today) ? clockTime :
    created.getFullYear() === today.getFullYear() ? shortDay : shortDate;
  const initial = Array.from(item.actorName.trim())[0]?.toLocaleUpperCase('fr-FR');
  const canManage = item.type === 'join_requested' && !item.decision && item.requestPending !== false && onManage;
  const readLabel = item.readAt ? 'Marquer comme non lue' : 'Marquer comme lue';
  const archiveLabel = item.archivedAt ? 'Restaurer la notification' : 'Archiver la notification';
  return <li ref={row} data-inbox-row="" data-unread={item.readAt ? undefined : ''}>
    <span data-inbox-avatar="" aria-hidden="true">{initial || <Icon svg={IconPeople}/>}</span>
    <p id={titleId} data-inbox-description=""><Description item={item}/></p>
    <time data-inbox-date="" dateTime={item.createdAt} title={dates.format(created)} aria-label={dates.format(created)}>{format.format(created)}</time>
    {item.requestMessage && <blockquote data-inbox-message="">{item.requestMessage}</blockquote>}
    <Decision item={item}/>
    {item.pageId && onOpenPage && <button type="button" data-inbox-open-request="" aria-describedby={titleId} onClick={() => onOpenPage(item.pageId!)}>Ouvrir la page</button>}
    {canManage && <button type="button" data-inbox-open-request="" onClick={onManage} aria-describedby={titleId}><span data-inbox-read-label="">Voir les demandes</span></button>}
    <div data-inbox-row-actions="" role="group" aria-describedby={titleId} aria-label="Actions de la notification">
      <button type="button" data-inbox-read="" aria-disabled={saving} title={readLabel} onClick={() => void apply('read')}>
        <Icon svg={item.readAt ? IconMail : IconCheck}/><span data-inbox-read-label="">{readLabel}</span>
      </button>
      <button type="button" data-inbox-archive="" aria-disabled={saving} title={archiveLabel} onClick={() => void apply('archive')}>
        <Icon svg={item.archivedAt ? IconUndo : IconInbox}/><span data-inbox-read-label="">{archiveLabel}</span>
      </button>
    </div>
  </li>;
}

function NotificationFeed({items, onAction, onManage, onOpenPage}: RowActions & {items: WorkspaceNotification[]}) {
  const today = new Date();
  const groups = new Map<string, WorkspaceNotification[]>();
  // The API prioritizes unread entries. The feed groups all entries by their occurrence.
  const chronological = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const item of chronological) {
    const label = dateGroup(dayNumber(today) - dayNumber(new Date(item.createdAt)));
    const group = groups.get(label);
    if (group) group.push(item);
    else groups.set(label, [item]);
  }
  return <section data-inbox-feed="" aria-label="Notifications de l’espace">
    {Array.from(groups, ([label, entries]) => <Fragment key={label}>
      <h3 data-inbox-period="">{label}</h3>
      <ul aria-label={label}>
        {entries.map(item => <NotificationRow key={item.id} item={item} today={today} onAction={onAction} onManage={onManage} onOpenPage={onOpenPage}/>)}
      </ul>
    </Fragment>)}
  </section>;
}

interface ListHandle {refresh(): Promise<void>}
function NotificationList({options, handle, attachActions}: {
  options: NotificationListOptions;
  handle: Ref<ListHandle>;
  attachActions: (slot: HTMLSpanElement | null) => void;
}) {
  const [items,setItems] = useState<WorkspaceNotification[] | null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [unreadCount,setUnreadCount] = useState(0);
  const [markingAll,setMarkingAll] = useState(false);
  const archived = filter === 'archived';
  const visibleItems = filter === 'unread' ? items?.filter(item => !item.readAt) : items;
  const filterButton = useRef<HTMLButtonElement>(null);
  const focusAfterRemoval = useRef<HTMLLIElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const fetching = useRef(false);

  const load = useCallback(async (quiet = false) => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || (quiet && fetching.current)) return;
    const current = ++revision.current;
    fetching.current = true;
    if (!quiet) { setLoading(true); setError(''); }
    try {
      const result = await fetchNotifications(options, signal, archived);
      if (signal.aborted || current !== revision.current) return;
      options.onUnreadCount?.(result.unreadCount);
      if (!archived) options.onInboxItems?.(result.notifications);
      setUnreadCount(result.unreadCount);
      setItems(result.notifications);
      setError('');
    } catch {
      if (!quiet && !signal.aborted && current === revision.current) {
        setItems(null);
        setError('Impossible de charger les notifications. Réessayez.');
      }
    } finally {
      if (!signal.aborted && current === revision.current) { fetching.current = false; setLoading(false); }
    }
  }, [options, archived]);

  useLayoutEffect(() => {
    const life = new AbortController();
    controller.current = life;
    focusAfterRemoval.current = null;
    setItems(null);
    setMarkingAll(false);
    void load();
    return () => {life.abort();};
  }, [load]);
  useImperativeHandle(handle, () => ({refresh: () => load(true)}), [load]);
  useLayoutEffect(() => {
    const row = focusAfterRemoval.current;
    if (loading || !row) return;
    focusAfterRemoval.current = null;
    if (row.contains(document.activeElement) || document.activeElement === document.body) {
      filterButton.current?.focus();
    }
  }, [items, loading, error]);

  async function onAction(item: WorkspaceNotification, action: RowAction, row: HTMLLIElement) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setError('');
    try {
      if (action === 'archive') await setNotificationArchived(options, item.id, !item.archivedAt, signal);
      else await setNotificationRead(options, item.id, !item.readAt, signal);
      if (signal.aborted) return;
      if (row.contains(document.activeElement) && (action === 'archive' || filter === 'unread')) {
        focusAfterRemoval.current = row;
      }
      await load();
    } catch {
      if (!signal.aborted) setError(action === 'archive' ? 'Impossible de modifier l’archivage. Réessayez.' : 'Impossible de marquer la notification. Réessayez.');
    }
  }
  async function markAllRead() {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || markingAll || unreadCount === 0) return;
    setMarkingAll(true);
    setError('');
    try {
      await readAllNotifications(options,signal);
      if (signal.aborted) return;
      options.onUnreadCount?.(0);
      setUnreadCount(0);
      await load();
    } catch {
      if (!signal.aborted) setError('Impossible de marquer toutes les notifications comme lues. Réessayez.');
    } finally {
      if (!signal.aborted) setMarkingAll(false);
    }
  }
  return <>
    <NotificationHeader attachActions={attachActions} filter={filter} onFilter={setFilter}
      filterButton={filterButton} loading={loading} onRefresh={() => void load()}
      hasItems={Boolean(visibleItems?.length)} canMarkAll={!archived && unreadCount>0 && !loading && !markingAll}
      onMarkAll={() => void markAllRead()}/>
    <p role="status">{loading ? 'Chargement des notifications…' : visibleItems?.length === 0 ? <>
      <span data-inbox-empty-icon="" aria-hidden="true"><Icon svg={IconCheck}/></span>
      {filter === 'archived' ? 'Aucune notification archivée.' : filter === 'unread' ? 'Aucune notification non lue.' : 'Vous êtes à jour.'}
    </> : null}</p>
    <p role="alert">{error}{error && !items && <button type="button" onClick={() => void load()}>Actualiser</button>}</p>
    <NotificationFeed items={visibleItems ?? []} onAction={onAction} onManage={options.onManageRequests} onOpenPage={options.onOpenPage}/>
  </>;
}

export function mountNotificationList(container: HTMLElement, options: NotificationListOptions) {
  const panel = document.createElement('section');
  panel.setAttribute('data-blok-notifications', '');
  container.append(panel);
  const root = createRoot(panel);
  const actions = document.createElement('span');
  actions.style.display = 'contents';
  let mounted: () => void;
  const ready = new Promise<void>(resolve => { mounted = resolve; });
  const attachActions = (slot: HTMLSpanElement | null) => {
    if (slot) { slot.append(actions); mounted(); }
  };
  const handle = createRef<ListHandle>();
  // The shell mounts its pin and close controls and focuses the sheet synchronously.
  flushSync(()=>root.render(<NotificationList options={options} handle={handle} attachActions={attachActions}/>));
  return {
    actions, ready,
    refresh: async () => { await handle.current?.refresh(); },
    destroy() { root.unmount(); panel.remove(); },
  };
}
