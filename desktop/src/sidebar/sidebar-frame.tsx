import { createRef } from 'react';
import type { LibraryView } from '../library-route';
import type { UpcomingCalendar } from './upcoming-events';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { PageFrame, ShellPage, createPageFrame } from '@blok/sidebar';
import {
  createSidebarPreferences,
  type SidebarPrompt,
} from '../../../src/shell/sidebar-preferences';
import type { SidebarMode } from '../sidebar-modes';
import { withAncestors } from './page-hierarchy';
import { mountedElement } from './sidebar-elements';
import { SidebarMenuRevision } from './sidebar-menu';
import { Sidebar } from './sidebar';

export type SidebarOptions = Parameters<typeof createPageFrame>[0] & {
  loadingPages?: boolean;
  onDownloadDesktop?(): void;
  onConnectCalendar?(): void;
  canCreateTeamspace?: boolean;
  onCreateTeamspace?(): void;
  onOpenLibrarySection?(view: LibraryView): void;
  upcomingEvents?: (signal: AbortSignal) => Promise<UpcomingCalendar>;
  teamspaceActions?: readonly { name: string; title: string; run(): void }[];
};

export function createReactPageFrame(
  options: SidebarOptions,
): PageFrame & { setPagesError(): void; destroy(): void } {
  const element = document.createElement('div');
  element.setAttribute('data-blok-shell', '');
  element.setAttribute('data-blok-interface', 'shell');
  const root = createRoot(element);
  const canvas = createRef<HTMLElement>();
  const headerActions = createRef<HTMLDivElement>();
  const prompts: SidebarPrompt[] = ['customize'];
  if (options.onInviteMembers) prompts.push('invite');
  if (options.onDownloadDesktop) prompts.push('download');
  const prefs = createSidebarPreferences(
    options.preferenceKey,
    Boolean(options.onCalendar && options.onHome),
    prompts,
  );
  const expanded = new Map<string, boolean>();
  const state = {
    pages: options.pages,
    pagesStatus: (options.loadingPages ? 'loading' : 'ready') as 'loading' | 'ready' | 'error',
    activeId: options.activeId,
    mode: 'home' as SidebarMode,
    collapsed: false,
    menuRevision: 0,
    recents: [...new Set(options.recentIds ?? [])].slice(0, 50),
  };

  function reveal() {
    if (!options.collapsedByDefault) return;
    const parent = state.pages.find((page) => page.id === state.activeId)?.parentId;
    if (!parent) return;
    for (const id of withAncestors([parent], state.pages)) expanded.set(id, true);
  }

  function remember() {
    if (!state.activeId || state.recents.slice(0, 5).includes(state.activeId)) return;
    state.recents = [state.activeId, ...state.recents.filter((id) => id !== state.activeId)].slice(
      0,
      50,
    );
    options.onRecentsChange?.([...state.recents]);
  }

  function toggleSidebar() {
    state.menuRevision += 1;
    state.collapsed = !state.collapsed;
    render();
  }

  element.addEventListener('keydown', (event) => {
    if (
      event.defaultPrevented ||
      !(event.ctrlKey || event.metaKey) ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (options.onSearch && ['k', 'p'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      options.onSearch();
    } else if (
      event.key === '\\' &&
      !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      toggleSidebar();
    }
  });

  function render() {
    flushSync(() =>
      root.render(
        <>
          <SidebarMenuRevision.Provider value={state.menuRevision}>
            <Sidebar
              options={options}
              pages={state.pages}
              pagesStatus={state.pagesStatus}
              activeId={state.activeId}
              mode={state.mode}
              recents={state.recents}
              prefs={prefs}
              collapsed={state.collapsed}
              toggleSidebar={toggleSidebar}
              headerActions={headerActions}
              expanded={expanded}
              onExpand={(id, value) => {
                expanded.set(id, value);
                render();
              }}
              onFavorite={(id) => {
                const page = state.pages.find((item) => item.id === id);
                if (!page) return;
                page.favorite = !page.favorite;
                options.onFavorite?.(id, page.favorite);
                render();
              }}
            />
          </SidebarMenuRevision.Provider>
          <main
            ref={canvas}
            data-blok-sidebar-canvas=""
          />
        </>,
      ),
    );
  }
  reveal();
  remember();
  render();

  return {
    element,
    canvas: mountedElement(canvas.current, 'canvas'),
    headerActions: mountedElement(headerActions.current, 'header actions'),
    sidebarPreferences: prefs,
    toggleSidebar,
    destroy: () => root.unmount(),
    setPagesError() {
      if (state.pagesStatus !== 'loading') return;
      state.pagesStatus = 'error';
      render();
    },
    setPages(next: ShellPage[], id: string) {
      const revealActive = state.activeId !== id || !state.pages.some((page) => page.id === id);
      state.menuRevision += 1;
      state.pagesStatus = 'ready';
      state.pages = [...next];
      state.activeId = id;
      if (revealActive) reveal();
      const available = new Set(state.pages.map((page) => page.id));
      state.recents = state.recents.filter((id) => available.has(id));
      if (state.mode !== 'calendar') remember();
      render();
    },
    setCalendarActive(active) {
      if (active === (state.mode === 'calendar')) return;
      state.menuRevision += 1;
      state.mode = active ? 'calendar' : 'home';
      render();
    },
    setChatActive(active) {
      if (state.mode === 'calendar' || active === (state.mode === 'chat')) return;
      state.mode = active ? 'chat' : 'home';
      render();
    },
  };
}
