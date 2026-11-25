import {useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject} from 'react';
import {IconCheck, IconDotsHorizontal, IconFilter, IconRefresh} from '../../../src/components/icons';
import './notification-header.css';

export type InboxFilter = 'all' | 'unread' | 'archived';
type Menu = 'filter' | 'actions';

interface HeaderProps {
  attachActions(slot: HTMLSpanElement | null): void;
  filter: InboxFilter;
  onFilter(filter: InboxFilter): void;
  onRefresh(): void;
  loading: boolean;
  hasItems: boolean;
  canMarkAll: boolean;
  onMarkAll(): void;
  filterButton: RefObject<HTMLButtonElement | null>;
}

const filters = [
  {value: 'all', label: 'Toutes les notifications'},
  {value: 'unread', label: 'Non lues'},
  {value: 'archived', label: 'Archivées'},
] as const;

function Glyph({source}: {source: string}) {
  return <span aria-hidden="true" dangerouslySetInnerHTML={{__html:source}}/>;
}

export function NotificationHeader({attachActions, filter, onFilter, onRefresh, loading, filterButton, hasItems, canMarkAll, onMarkAll}: HeaderProps) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const opener = menu === 'filter' ? filterButton : actionsButton;

  useLayoutEffect(() => {
    if (!menu) return;
    const selector = menu === 'filter' ? '[aria-pressed="true"]' : 'button:not(:disabled)';
    const target = popup.current?.querySelector<HTMLElement>(selector) ?? popup.current;
    target?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    function outside(event: PointerEvent) {
      const path = event.composedPath();
      if (popup.current && opener.current && !path.includes(popup.current) && !path.includes(opener.current)) setMenu(null);
    }
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [menu, opener]);

  function close() {
    setMenu(null);
    opener.current?.focus();
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  return <header data-notification-header="" onKeyDown={event => {
    if (event.key === 'Escape' && menu) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}>
    <h2>Notifications</h2>
    <span data-inbox-actions="" ref={attachActions}/>
    <button type="button" ref={filterButton} title="Filtrer les notifications" aria-label="Filtrer les notifications"
      aria-haspopup="dialog" aria-expanded={menu === 'filter'} aria-controls={menu === 'filter' ? popupId : undefined}
      data-filter-active={filter !== 'all' ? '' : undefined} onClick={() => setMenu(menu === 'filter' ? null : 'filter')}>
      <Glyph source={IconFilter}/>
    </button>
    {(hasItems || menu === 'actions') && <button type="button" ref={actionsButton} title="Plus d’actions" aria-label="Plus d’actions"
      aria-haspopup="dialog" aria-expanded={menu === 'actions'} aria-controls={menu === 'actions' ? popupId : undefined}
      onClick={() => setMenu(menu === 'actions' ? null : 'actions')}>
      <Glyph source={IconDotsHorizontal}/>
    </button>}
    {menu && <div data-inbox-menu="" role="dialog" ref={popup} id={popupId} tabIndex={-1}
      aria-label={menu === 'filter' ? 'Filtrer les notifications' : 'Plus d’actions'} onKeyDown={navigate}
      onBlur={event => {
        if (event.relatedTarget !== opener.current && !event.currentTarget.contains(event.relatedTarget)) setMenu(null);
      }}>
      {menu === 'filter' ? filters.map(option =>
        <button type="button" key={option.value} aria-pressed={filter === option.value}
          onClick={() => { onFilter(option.value); close(); }}>
          {option.label}{filter === option.value && <Glyph source={IconCheck}/>}
        </button>
      ) : <button type="button" disabled={!canMarkAll} onClick={() => {
        close();
        if (filter === 'unread') filterButton.current?.focus();
        onMarkAll();
      }}>
        <Glyph source={IconCheck}/>Tout marquer comme lu
      </button>}
      {(menu === 'actions' || !hasItems) && <button type="button" disabled={loading} onClick={() => { close(); onRefresh(); }}>
        <Glyph source={IconRefresh}/>Actualiser
      </button>}
    </div>}
  </header>;
}
