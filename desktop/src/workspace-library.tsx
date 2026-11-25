import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { IconClock, IconEmojiStar, IconFilter, IconLock, IconPeople, IconSearch, IconSidebarRight, IconSliders, IconTable, IconChevronDown } from '../../src/components/icons';
import { libraryTable } from './library-table';
import { normalize } from './page-search-results';
import { sectionNames } from './page-section';
import type { LibraryView } from './library-route';
import type { DesktopPage } from './storage';
import './workspace-library.css';

const views = {
  recents: {label: 'Récents', icon: IconClock, empty: 'Les pages que vous consultez apparaîtront ici.'},
  favorites: {label: 'Favoris', icon: IconEmojiStar, empty: 'Les pages ajoutées à vos favoris apparaîtront ici.'},
  private: {label: 'Privé', icon: IconLock, empty: 'Aucune page privée.'},
  shared: {label: 'Partagé', icon: IconPeople, empty: 'Aucune page partagée.'},
} satisfies Record<LibraryView, {label: string; icon: string; empty: string}>;

export type {LibraryView} from './library-route';
interface LibraryOptions {
  workspaceName: string;
  pages(): DesktopPage[];
  recentIds(): string[];
  visitedAt(id: string): number | undefined;
  view(): LibraryView;
  onViewChange(view: LibraryView): void;
  onOpen(id: string): void;
  onCreate?(): void;
  onClosePeek?(): void;
  isTeamspaces?(): boolean;
  onCreateTeamspace?(): void;
  onVisiblePagesChange?(ids: readonly string[]): void;
  selectedPageId?(): string | undefined;
  onToggleSidebar?(): void;
}

function Glyph({icon}: {icon: string}) {
  return <span className="library-glyph" aria-hidden="true" dangerouslySetInnerHTML={{__html: icon}}/>;
}

function sectionOf(page: DesktopPage, index: Map<string, DesktopPage>): string | undefined {
  const seen = new Set<string>();
  let cursor: DesktopPage | undefined = page;
  while (cursor && !seen.has(cursor.id)) {
    if (cursor.section) return cursor.section;
    seen.add(cursor.id);
    cursor = cursor.parentId ? index.get(cursor.parentId) : undefined;
  }
  return undefined;
}

function Library({options, publishRows}: {options: LibraryOptions; publishRows(ids: string[]): void}) {
  const view = options.view();
  const teamspaces = options.isTeamspaces?.() ?? false;
  const create = teamspaces ? options.onCreateTeamspace : options.onCreate;
  const peekId = options.selectedPageId?.();
  const tableHost = useRef<HTMLDivElement>(null);
  const grid = useRef<ReturnType<typeof libraryTable> | null>(null);
  useLayoutEffect(() => {
    const host = tableHost.current;
    if (!host) return;
    grid.current = libraryTable(host, id => {
      if (options.pages().some(page => page.id === id)) options.onOpen(id);
    }, () => options.onClosePeek?.());
    return () => { grid.current?.destroy(); grid.current = null; };
  }, [options]);
  const heading = useRef<HTMLHeadingElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [tool, setTool] = useState<'filter' | 'display' | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rootsOnly, setRootsOnly] = useState(false);
  const [locationVisible, setLocationVisible] = useState(false);
  const [sort, setSort] = useState<'default' | 'asc' | 'desc'>('default');
  const toolId = useId();
  const checkbox = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (tool) checkbox.current?.focus(); }, [tool]);
  useLayoutEffect(() => { heading.current?.focus({preventScroll: true}); }, []);
  useLayoutEffect(() => { if (searchOpen) search.current?.focus(); }, [searchOpen]);
  useEffect(() => {
    if (!tool) return;
    const outside = (event: PointerEvent) => { if (!tools.current?.contains(event.target as Node)) setTool(null); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault(); setTool(null); trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [tool]);

  const pages = options.pages();
  const index = new Map(pages.map(page => [page.id, page]));
  const recent = new Map(options.recentIds().map((id, i) => [id, i]));
  const needle = normalize(query);
  const rows = pages.filter(page => {
    if (rootsOnly && page.parentId) return false;
    if (!normalize(page.title || 'Nouvelle page').includes(needle)) return false;
    if (view === 'recents') return recent.has(page.id) || options.visitedAt(page.id) !== undefined;
    if (view === 'favorites') return page.favorite;
    return sectionOf(page, index) === sectionNames[view];
  });
  const title = (page: DesktopPage) => page.title || 'Nouvelle page';
  if (sort !== 'default') {
    rows.sort((a, b) => title(a).localeCompare(title(b), 'fr', {numeric: true, sensitivity: 'base'}) * (sort === 'asc' ? 1 : -1));
  } else if (view === 'recents') {
    rows.sort((a,b) => (options.visitedAt(b.id) ?? 0) - (options.visitedAt(a.id) ?? 0)
      || (recent.get(a.id) ?? Infinity) - (recent.get(b.id) ?? Infinity));
  }

  useLayoutEffect(() => { publishRows(rows.map(page => page.id)); });
  useLayoutEffect(() => {
    grid.current?.update(views[view].label, rows, locationVisible
      ? page => index.get(page.parentId ?? '')?.title || options.workspaceName
      : undefined, peekId);
  });
  return <section className="workspace-library" aria-label="Bibliothèque">
    <header className="library-titlebar">
      {options.onToggleSidebar && <button type="button" data-desktop-sidebar-toggle="" aria-label="Afficher ou masquer la barre latérale"
        title="Afficher ou masquer la barre latérale" onClick={options.onToggleSidebar}><Glyph icon={IconSidebarRight}/></button>}
      <h1 ref={heading} tabIndex={-1}>Bibliothèque</h1>
      {create && <button type="button" className="library-create" onClick={create}>{teamspaces ? 'Nouvel espace d’équipe' : 'Nouvelle page'}</button>}
    </header>
    <h2>{views[view].label}</h2>
    <div className="library-toolbar">
      <nav aria-label="Vues de la bibliothèque">
        {(Object.keys(views) as LibraryView[]).map(id => <button key={id} type="button" aria-current={id === view ? 'page' : undefined}
          onClick={() => { setTool(null); options.onViewChange(id); }}><Glyph icon={views[id].icon}/>{views[id].label}</button>)}
      </nav>
      <label className="library-view-picker"><Glyph icon={IconTable}/>
        <span>{views[view].label}</span><Glyph icon={IconChevronDown}/>
        <select aria-label="Vue de la bibliothèque" value={view} onChange={event => options.onViewChange(event.currentTarget.value as LibraryView)}>
          {(Object.keys(views) as LibraryView[]).map(id => <option value={id} key={id}>{views[id].label}</option>)}
        </select>
      </label>
      <div className="library-tools" ref={tools} onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setTool(null);
      }}>
        <button type="button" aria-label="Filtrer" title="Filtrer" aria-expanded={tool === 'filter'} aria-controls={tool === 'filter' ? toolId : undefined}
          data-applied={rootsOnly || undefined} onClick={e => {trigger.current = e.currentTarget; setTool(tool === 'filter' ? null : 'filter');}}><Glyph icon={IconFilter}/></button>
        <button type="button" aria-label="Rechercher une page dans cette vue" title="Rechercher" aria-expanded={searchOpen}
          onClick={() => {setTool(null); setSearchOpen(!searchOpen); setQuery('');}}><Glyph icon={IconSearch}/></button>
        <button type="button" aria-label="Options d’affichage" title="Options d’affichage" aria-expanded={tool === 'display'} aria-controls={tool === 'display' ? toolId : undefined}
          onClick={e => {trigger.current = e.currentTarget; setTool(tool === 'display' ? null : 'display');}}><Glyph icon={IconSliders}/></button>
        {tool && <div className="library-menu" id={toolId}>
          {tool === 'filter' ? <label><input ref={checkbox} type="checkbox" checked={rootsOnly} onChange={e => setRootsOnly(e.target.checked)}/>Pages de premier niveau</label>
            : <><label><input ref={checkbox} type="checkbox" checked={locationVisible} onChange={e => setLocationVisible(e.target.checked)}/>Afficher l’emplacement</label>
                <label>Tri <select value={sort} onChange={event => setSort(event.currentTarget.value as typeof sort)}>
                  <option value="default">Ordre de la vue</option><option value="asc">Nom de A à Z</option><option value="desc">Nom de Z à A</option>
                </select></label></>}
        </div>}
      </div>
    </div>
    {searchOpen && <div className="library-search"><Glyph icon={IconSearch}/><input ref={search} type="search" placeholder="Rechercher dans cette vue…"
      aria-label="Rechercher dans cette vue" value={query} onChange={e => setQuery(e.target.value)}
      onKeyDown={e => { if (e.key === 'Escape') {e.preventDefault(); setSearchOpen(false); setQuery(''); tools.current?.querySelector<HTMLButtonElement>('[title="Rechercher"]')?.focus();} }}/></div>}
    <div ref={tableHost} data-library-grid="" data-blok-interface=""/>
    {rows.length === 0 && <p role="status" className="library-empty">{query || rootsOnly ? 'Aucune page ne correspond à ce filtre.' : views[view].empty}</p>}
  </section>;
}

export function mountWorkspaceLibrary(host: HTMLElement, options: LibraryOptions) {
  const root = createRoot(host);
  let visibleIds: string[] = [];
  const publishRows = (ids: string[]) => {
    if (ids.length === visibleIds.length && ids.every((id, i) => id === visibleIds[i])) return;
    visibleIds = ids;
    options.onVisiblePagesChange?.(ids);
  };
  const refresh = () => flushSync(() => root.render(<Library options={options} publishRows={publishRows}/>));
  refresh();
  return {refresh, getVisiblePageIds: () => [...visibleIds], destroy: () => root.unmount()};
}
