import {shellText} from '../shell-i18n';
import { Fragment, createContext, useContext, useRef, useState, type ReactNode } from 'react';
import type { SidebarMode } from '../sidebar-modes';
import type { SidebarPreferences } from '../../../src/shell/sidebar-preferences';
import type { SidebarOptions } from './sidebar-frame';

export const navigationLabels = {
  newPage: shellText("Nouvelle page"),
  newChat: shellText("Nouvelle discussion"),
  library: shellText("Bibliothèque"),
  teamsLink: shellText("Espaces d’équipe"),
  events: shellText("Événements à venir"),
  recents: shellText("Récents"),
  favorites: shellText("Favoris"),
  workspace: shellText("Pages de l’espace"),
  Partagé: shellText("Partagé"),
  Privé: shellText("Privé"),
};
export type NavigationId = keyof typeof navigationLabels;
export const tabLabels = { home: shellText("Accueil"), chat: shellText("Discussions"), calendar: shellText("Calendrier") };
export type NavigationItem = { id: string; content: ReactNode };
export const pageSortLabels = {
  edited: shellText("Dernière modification"),
  title: shellText("Titre"),
  manual: shellText("Ordre manuel"),
} as const;
export type PageSort = keyof typeof pageSortLabels;
type Placement = { sort?: PageSort; tab?: SidebarMode; hiddenIn?: SidebarMode[]; limit?: number };
type Layout = { order: Partial<Record<SidebarMode, string[]>>; items: Record<string, Placement> };
const defaults: Layout = { order: {}, items: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isTab(value: unknown): value is SidebarMode {
  return value === 'home' || value === 'chat' || value === 'calendar';
}
function read(key: string | undefined, fallback = defaults): Layout {
  if (!key) return fallback;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return parseLayout(value, fallback);
  } catch {
    return fallback;
  }
}
function parseLayout(value: unknown, fallback: Layout): Layout {
  if (!isRecord(value) || !isRecord(value.order) || !isRecord(value.items)) return fallback;
  const items: Record<string, Placement> = Object.create(null) as Record<string, Placement>;
  for (const [id, entry] of Object.entries(value.items)) {
    if (!isRecord(entry)) continue;
    items[id] = {
      sort:
        entry.sort === 'edited' || entry.sort === 'title' || entry.sort === 'manual'
          ? entry.sort
          : undefined,
      tab: isTab(entry.tab) ? entry.tab : undefined,
      hiddenIn: Array.isArray(entry.hiddenIn) ? entry.hiddenIn.filter(isTab) : [],
      limit:
        typeof entry.limit === 'number' && [0, 5, 10, 20].includes(entry.limit)
          ? entry.limit
          : undefined,
    };
  }
  const order: Layout['order'] = {};
  for (const [tab, ids] of Object.entries(value.order)) {
    if (isTab(tab) && Array.isArray(ids))
      order[tab] = ids.filter((id: unknown) => typeof id === 'string');
  }
  return { order, items };
}
function useLayout(
  mode: SidebarMode,
  options: SidebarOptions,
  prefs: SidebarPreferences,
  pages: SidebarOptions['pages'],
) {
  const key = options.preferenceKey && `blok:sidebar:navigation:${options.preferenceKey}`;
  const [layout, setLayout] = useState(() => read(key));
  const customizeButton = useRef<HTMLButtonElement>(null);
  const tabs: SidebarMode[] = ['home'];
  if (options.onChat) tabs.push('chat');
  if (options.onCalendar && options.onHome) tabs.push('calendar');
  function save(update: (previous: Layout) => Layout) {
    const next = update(read(key, layout));
    try {
      if (key) localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Disponible pour cette session. */
    }
    setLayout(next);
  }
  function place(id: string, changes: Placement) {
    save((previous) => ({
      ...previous,
      items: { ...previous.items, [id]: { ...previous.items[id], ...changes } },
    }));
  }
  function show(id: string, visible: boolean) {
    if (id === 'events' || id === 'favorites') prefs.set(id, visible);
    else {
      const hidden = new Set(layout.items[id]?.hiddenIn);
      if (visible) hidden.delete(mode);
      else hidden.add(mode);
      place(id, { hiddenIn: [...hidden] });
    }
  }
  function visible(id: string) {
    if (id === 'events' || id === 'favorites') return prefs.getSnapshot()[id];
    return !layout.items[id]?.hiddenIn?.includes(mode);
  }
  function tab(id: string) {
    return layout.items[id]?.tab ?? mode;
  }
  function arrange(items: NavigationItem[]) {
    const ids = items.map((item) => item.id);
    const order = [...new Set([...(layout.order[mode] ?? []), ...ids])];
    return items
      .filter((item) => visible(item.id) && tab(item.id) === mode)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }
  function move(siblings: string[], id: string, delta: number) {
    const from = siblings.indexOf(id),
      to = from + delta;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    save((previous) => {
      const order = [...new Set([...(previous.order[mode] ?? []), ...siblings])];
      const a = order.indexOf(id),
        b = order.indexOf(siblings[to]);
      [order[a], order[b]] = [order[b], order[a]];
      return { ...previous, order: { ...previous.order, [mode]: order } };
    });
  }
  return {
    mode,
    tabs,
    options,
    visible,
    arrange,
    move,
    place,
    show,
    tab,
    customizeButton,
    prefs,
    pages,
    sort: (id: string) => layout.items[id]?.sort ?? 'edited',
    limit: (id: string) => layout.items[id]?.limit ?? (id === 'recents' ? 5 : 10),
    customize: () => requestAnimationFrame(() => customizeButton.current?.click()),
  };
}
const LayoutContext = createContext<ReturnType<typeof useLayout> | null>(null);
export const useNavigationLayout = () => useContext(LayoutContext);

export const NavigationLayout = ({
  mode,
  options,
  prefs,
  children,
  pages = options.pages,
}: {
  pages?: SidebarOptions['pages'];
  mode: SidebarMode;
  options: SidebarOptions;
  prefs: SidebarPreferences;
  children: ReactNode;
}) => (
  <LayoutContext.Provider value={useLayout(mode, options, prefs, pages)}>
    {children}
  </LayoutContext.Provider>
);

export const NavigationSiblings = createContext<string[]>([]);

export const NavigationGroup = ({ items }: { items: NavigationItem[] }) => {
  const layout = useNavigationLayout();
  const visible = layout?.arrange(items) ?? items;
  return (
    <NavigationSiblings.Provider value={visible.map((item) => item.id)}>
      {visible.map((item) => (
        <Fragment key={item.id}>{item.content}</Fragment>
      ))}
    </NavigationSiblings.Provider>
  );
};
