<<<<<<< HEAD
import { libraryView } from './library-route';
import { calendarUrl, editorUrl, isCalendarUrl } from './calendar-route';
import { pageUrlForView, pageView, workspacePageLink, type PageView } from './page-link';
import { renderPageIcon } from '../../src/shell/page-icon';
import { activeWorkspace, workspaceKey, type WorkspaceRef } from './workspace-registry';
import { createWorkspace, type Workspace } from './workspace';
import { applyAppearance, readAppearance, watchSystemAppearance } from './settings';

import { buildTabMenuItems, type TabMenuAction } from './tab-menu';
import { applyFavicon } from './tab-identity';

function tabKey(): string {
  const key = workspaceKey(box.mountedWorkspace ?? activeWorkspace());
  return key === 'local:default' ? 'blok:window-tabs:v1' : `blok:window-tabs:v1:${key}`;
}
const MAX_TABS = 20;
const MAX_HISTORY = 100;

interface Tab {
  id: string;
  href: string;
  title: string;
  icon: string;
  scrollY: number;
  entries: string[];
  scrollPositions: number[];
  index: number;
}

interface Session {
  tabs: Tab[];
  activeId: string;
}

const natives = {
  push: History.prototype.pushState,
  replace: History.prototype.replaceState,
};

const installed = { history: false, title: false, keys: false, menu: false };

const slot: {
  record: (mode: 'push' | 'replace', href: string) => void;
  syncTitle: () => void;
  onKey: (event: KeyboardEvent) => void;
} = {
  record: () => undefined,
  syncTitle: () => undefined,
  onKey: () => undefined,
};

const box: {
  root: HTMLElement | null;
  session: Session;
  canLeave: () => boolean;
  workspace: Workspace | null;
  mountedWorkspace?: WorkspaceRef;
} = {
  root: null,
  session: { tabs: [], activeId: '' },
  canLeave: () => true,
  workspace: null,
};

export async function flushDesktop(): Promise<void> { await box.workspace?.flush(); }

/** Reuse the editor and its live connection when the OS opens a page in this workspace. */
export async function openMountedPage(ref: WorkspaceRef, id: string, view: PageView = 'document'): Promise<boolean> {
  if (!box.mountedWorkspace || workspaceKey(box.mountedWorkspace) !== workspaceKey(ref) || !box.workspace?.hasPage(id)) return false;
  const isTarget = (href: string) => {
    const url = new URL(href);
    return !isCalendarUrl(url) && !libraryView(url) && url.searchParams.get('page') === id && pageView(url) === view;
  };
  if (isTarget(location.href)) return true;
  await flushDesktop();
  const existing = box.session.tabs.find(tab => isTarget(tab.href));
  if (existing) moveTo(existing.id, false);
  else if (box.session.tabs.length < MAX_TABS) createTab({id, title: '', view});
  else history.pushState(null, '', pageUrlForView(new URL(homeHref()), id, view));
  return true;
}

export function setCanLeave(guard: () => boolean): void {
  box.canLeave = guard;
}

export function mountDesktop(root: HTMLElement, ref: WorkspaceRef = activeWorkspace()): void {
  install();
  box.root = root;
  box.mountedWorkspace = ref;
  root.setAttribute('data-desktop-shell', '');
  applyAppearance(root, readAppearance());
  watchSystemAppearance(root);
  root.toggleAttribute('data-tauri', isTauri());
  box.session = isTauri() ? boot() : { tabs: [], activeId: '' };
  const current = active();
  if (current && current.href !== location.href) nativeReplace(current.href);
  if (current && document.title !== current.title) document.title = current.title;
  applyFavicon(current?.icon);
  box.workspace = createWorkspace((width) => {
    root.style.setProperty('--desktop-sidebar-width', `${Math.max(isTauri() ? 156 : 84, width)}px`);
  }, syncPageIcon, {ref});
  root.replaceChildren(...(isTauri() ? [strip(), box.workspace.element] : [box.workspace.element]));
  root.addEventListener('click', onClick);
  root.addEventListener('contextmenu', onContextMenu);
  slot.record = record;
  slot.syncTitle = syncTitle;
  slot.onKey = onKey;
  persist();
  paint();
  root.addEventListener('blok:desktop-select-workspace', (event) => {
    const ref = (event as CustomEvent).detail;
    void box.workspace?.flush().then(async () => { const { selectWorkspace } = await import('./workspace-registry'); selectWorkspace(ref); }).catch((error: unknown) => window.alert(String(error)));
  });
  void box.workspace.start();
}

function install(): void {
  installKeys();
  if (isTauri()) {
    installHistory();
    installTitle();
    installMenu();
  }
}

function installHistory(): void {
  if (installed.history) return;
  installed.history = true;
  const pushState: History['pushState'] = function pushState(this: History, data, unused, url) {
    if (!isTauri()) return natives.push.call(this, data, unused, url);
    void unused;
    const href = resolveHref(url);
    natives.replace.call(this, data, '', url);
    slot.record('push', href);
  };
  const replaceState: History['replaceState'] = function replaceState(this: History, data, unused, url) {
    if (!isTauri()) return natives.replace.call(this, data, unused, url);
    void unused;
    const href = resolveHref(url);
    natives.replace.call(this, data, '', url);
    slot.record('replace', href);
  };
  History.prototype.pushState = pushState;
  History.prototype.replaceState = replaceState;
}

function installTitle(): void {
  if (installed.title) return;
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
  if (!desc || !desc.set || !desc.get || !desc.configurable) return;
  installed.title = true;
  const get = desc.get;
  const set = desc.set;
  Object.defineProperty(Document.prototype, 'title', {
    configurable: true,
    enumerable: desc.enumerable === true,
    get() {
      return get.call(this);
    },
    set(value: string) {
      set.call(this, value);
      slot.syncTitle();
    },
  });
}

function installKeys(): void {
  if (installed.keys) return;
  installed.keys = true;
  window.addEventListener('keydown', (event) => {
    slot.onKey(event);
  });
  window.addEventListener('popstate', () => {
    onPop();
  });
}

function installMenu(): void {
  if (installed.menu) return;
  installed.menu = true;
  window.addEventListener('blok:desktop-new-tab', event => {
    if (isTauri()) createTab(event instanceof CustomEvent ? event.detail : undefined);
  });
  let returnTab: string | undefined;
  window.addEventListener('blok:open-calendar', event => {
    if (!isTauri()) return;
    event.preventDefault();
    if (!allowed()) return;
    const current = active();
    if (current && isCalendarUrl(new URL(current.href))) return;
    returnTab = current?.id;
    const existing = box.session.tabs.find(tab => isCalendarUrl(new URL(tab.href)));
    const href = calendarUrl(new URL(location.href)).href;
    if (existing) moveTo(existing.id, false);
    else if (box.session.tabs.length < MAX_TABS) addTab(href, 'Calendrier');
    else history.pushState(null, '', href);
  });
  window.addEventListener('blok:return-from-library-peek', event => {
    if (!isTauri()) return;
    event.preventDefault();
    const tab = active();
    if (tab && tab.index > 0) step(-1);
  });
  window.addEventListener('blok:return-from-calendar', event => {
    if (!isTauri()) return;
    const pages = box.session.tabs.filter(tab => !isCalendarUrl(new URL(tab.href)));
    const target = pages.find(tab => tab.id === returnTab) ?? pages.at(-1);
    if (target) { event.preventDefault(); moveTo(target.id, true); }
  });
  window.addEventListener('blok:desktop-reload', event => {
    if (!isTauri()) return;
    event.preventDefault();
    void reloadTab(box.session.activeId);
  });
  window.addEventListener('blok:desktop-close-tab', () => {
    if (isTauri()) closeActive();
  });
}

function boot(): Session {
  const restored = load(sessionStorage.getItem(tabKey()));
  const requested = new URL(location.href);
  const page = requested.searchParams.get('page');
  const calendar = isCalendarUrl(requested);
  const library = libraryView(requested);
  if (!restored || (!page && !calendar && !library)) return restored ?? freshSession();
  // An explicit page link takes precedence over the previously selected tab.
  const matchesRoute = (tab: Tab): boolean => {
    const url = new URL(tab.href);
    if (library) return url.pathname === requested.pathname && url.searchParams.get('p') === requested.searchParams.get('p');
    return calendar ? isCalendarUrl(url) : url.pathname === requested.pathname && !isCalendarUrl(url) && url.searchParams.get('page') === page && pageView(url) === pageView(requested);
  };
  const current = restored.tabs.find(tab => tab.id === restored.activeId);
  const existing = current && matchesRoute(current) ? current : restored.tabs.find(matchesRoute);
  if (existing) {
    existing.href = requested.href;
    existing.entries[existing.index] = requested.href;
    restored.activeId = existing.id;
  } else {
    const opened = freshTab(requested.href, calendar ? 'Calendrier' : library ? 'Bibliothèque' : 'Nouvelle page');
    restored.tabs.push(opened);
    restored.tabs = restored.tabs.slice(-MAX_TABS);
    restored.activeId = opened.id;
  }
  return restored;
}

function freshSession(): Session {
  const href = location.href;
  const tab = freshTab(href, readable(document.title));
  return { tabs: [tab], activeId: tab.id };
}

function freshTab(href: string, title: string): Tab {
  return {
    id: crypto.randomUUID(),
    href,
    title,
    icon: '',
    scrollY: 0,
    entries: [href],
    scrollPositions: [0],
    index: 0,
  };
}

function active(): Tab | null {
  return box.session.tabs.find((tab) => tab.id === box.session.activeId) ?? null;
}

function allowed(): boolean {
  return box.canLeave();
}

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

function closeEditorWindow(): void {
  const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
  if (!isRecord(internals)) return;
  const invoke: unknown = internals.invoke;
  if (typeof invoke !== 'function') return;
  void Promise.resolve(Reflect.apply(invoke, internals, ['close_editor_window', {}]));
}

function readable(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') return 'Nouvelle page';
  return trimmed;
}

function homeHref(): string {
  const url = editorUrl(new URL(location.href));
  url.search = '';
  url.hash = '';
  return url.href;
}

function resolveHref(url: string | URL | null | undefined): string {
  if (url === null || url === undefined) return location.href;
  return new URL(url, location.href).href;
}

function sameOrigin(href: string): boolean {
  try {
    return new URL(href).origin === location.origin;
  } catch {
    return false;
  }
}

function nativeReplace(href: string): void {
  natives.replace.call(history, null, '', href);
}

function withTab(session: Session, id: string, next: Tab): Session {
  return {
    activeId: session.activeId,
    tabs: session.tabs.map((tab) => (tab.id === id ? next : tab)),
  };
}

function snapshot(tab: Tab): Tab {
  const scrollY = window.scrollY;
  return {
    ...tab,
    scrollY,
    scrollPositions: tab.scrollPositions.map((value, i) => (i === tab.index ? scrollY : value)),
  };
}

function pushed(tab: Tab, href: string, scrollY: number): Tab {
  const kept = tab.entries.slice(0, tab.index + 1);
  const scrolls = tab.scrollPositions.slice(0, tab.index + 1).map((value, i) => {
    return i === tab.index ? scrollY : value;
  });
  return trimmed(tab, [...kept, href], [...scrolls, 0]);
}

function replaced(tab: Tab, href: string): Tab {
  return {
    ...tab,
    href,
    entries: tab.entries.map((entry, i) => (i === tab.index ? href : entry)),
  };
}

function trimmed(tab: Tab, entries: string[], scrollPositions: number[]): Tab {
  const overflow = entries.length - MAX_HISTORY;
  if (overflow <= 0) {
    return { ...tab, href: entries[entries.length - 1] ?? tab.href, entries, scrollPositions, index: entries.length - 1, scrollY: 0 };
  }
  const nextEntries = entries.slice(overflow);
  const nextScrolls = scrollPositions.slice(overflow);
  return {
    ...tab,
    href: nextEntries[nextEntries.length - 1] ?? tab.href,
    entries: nextEntries,
    scrollPositions: nextScrolls,
    index: nextEntries.length - 1,
    scrollY: 0,
  };
}

function record(mode: 'push' | 'replace', href: string): void {
  const tab = active();
  if (!tab || !sameOrigin(href)) return;
  const next = mode === 'push' ? pushed(tab, href, window.scrollY) : replaced(tab, href);
  box.session = withTab(box.session, tab.id, next);
  if (mode === 'push') window.scrollTo(0, 0);
  persist();
  paint();
  box.workspace?.onRoute();
}

function step(delta: number): void {
  if (!allowed()) return;
  const tab = active();
  if (!tab) return;
  const index = tab.index + delta;
  if (index < 0 || index >= tab.entries.length) return;
  const scrollPositions = tab.scrollPositions.map((value, i) => (i === tab.index ? window.scrollY : value));
  const href = tab.entries[index] ?? tab.href;
  const scrollY = scrollPositions[index] ?? 0;
  const next: Tab = { ...tab, scrollPositions, index, href, scrollY };
  box.session = withTab(box.session, tab.id, next);
  nativeReplace(href);
  window.scrollTo(0, scrollY);
  persist();
  paint();
  box.workspace?.onRoute();
}

function moveTo(id: string, check: boolean): void {
  if (check && !allowed()) return;
  const current = active();
  const next = box.session.tabs.find((tab) => tab.id === id);
  if (!current || !next || next.id === current.id) return;
  const saved = snapshot(current);
  box.session = {
    activeId: next.id,
    tabs: box.session.tabs.map((tab) => (tab.id === saved.id ? saved : tab)),
  };
  nativeReplace(next.href);
  window.scrollTo(0, next.scrollY);
  if (document.title !== next.title) document.title = next.title;
  applyFavicon(next.icon);
  persist();
  paint();
  box.workspace?.onRoute();
}

function createTab(page?: {id: string; title: string; icon?: string; view?: PageView}): void {
  if (!allowed()) return;
  if (box.session.tabs.length >= MAX_TABS) return;
  const home = new URL(homeHref());
  const url = page ? pageUrlForView(home, page.id, page.view) : home;
  addTab(url.href, page?.title || 'Nouvelle page', page?.icon);
}

function addTab(href: string, title: string, icon = ''): void {
  const current = active();
  const saved = current ? snapshot(current) : null;
  const tab = freshTab(href, title);
  tab.icon = icon;
  const tabs = box.session.tabs.map((item) => (saved && item.id === saved.id ? saved : item));
  box.session = { tabs: [...tabs, tab], activeId: tab.id };
  nativeReplace(href);
  window.scrollTo(0, 0);
  if (document.title !== tab.title) document.title = tab.title;
  applyFavicon(tab.icon);
  persist();
  paint();
  box.workspace?.onRoute();
}

function closeActive(): void {
  const tab = active();
  if (!tab) return;
  closeTab(tab.id);
}

function closeTab(id: string): void {
  if (!allowed()) return;
  if (box.session.tabs.length <= 1) {
    if (isTauri()) closeEditorWindow();
    return;
  }
  const index = box.session.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const wasActive = box.session.activeId === id;
  const neighbor = box.session.tabs[index + 1] ?? box.session.tabs[index - 1];
  const tabs = box.session.tabs.filter((tab) => tab.id !== id);
  const activeId = wasActive ? (neighbor?.id ?? '') : box.session.activeId;
  box.session = { tabs, activeId };
  const next = active();
  if (wasActive && next) reveal(next);
  persist();
  paint();
  box.workspace?.onRoute();
}

function reveal(next: Tab): void {
  nativeReplace(next.href);
  window.scrollTo(0, next.scrollY);
  if (document.title !== next.title) document.title = next.title;
  applyFavicon(next.icon);
}

function openPage(): void {
  box.workspace?.createPage();
}

function syncTitle(): void {
  const tab = active();
  if (!tab) return;
  const title = readable(document.title);
  const url = new URL(tab.href);
  const icon = isCalendarUrl(url) || libraryView(url) ? '' : tab.icon;
  const page = pageOf(tab.href);
  const tabs = box.session.tabs.map(item => {
    if (item.id === tab.id) return item.title === title && item.icon === icon ? item : {...item, title, icon};
    if (page && pageOf(item.href) === page && item.title !== title) return {...item, title};
    return item;
  });
  if (tabs.every((item, index) => item === box.session.tabs[index])) return;
  box.session = {...box.session, tabs};
  persist();
  paint();
}

function syncPageIcon(pageId: string, icon: string): void {
  // The web has no tab strip, so the URL — not a tab — says what is on screen.
  if (pageId === pageOf(location.href)) applyFavicon(icon);
  let changed = false;
  const tabs = box.session.tabs.map((tab) => {
    if (new URL(tab.href).searchParams.get('page') !== pageId || tab.icon === icon) return tab;
    changed = true;
    return { ...tab, icon };
  });
  if (!changed) return;
  box.session = { ...box.session, tabs };
  persist();
  paint();
}

function pageOf(href: string): string | null {
  try { return new URL(href).searchParams.get('page'); } catch { return null; }
}

function onPop(): void {
  if (!isTauri()) {
    box.workspace?.onRoute();
    return;
  }
  const tab = active();
  if (!tab) return;
  const href = location.href;
  const found = tab.entries.lastIndexOf(href);
  const scrollY = found >= 0 ? (tab.scrollPositions[found] ?? tab.scrollY) : tab.scrollY;
  const next = found >= 0
    ? { ...tab, index: found, href, scrollY }
    : replaced(tab, href);
  box.session = withTab(box.session, tab.id, next);
  if (found >= 0) window.scrollTo(0, scrollY);
  persist();
  paint();
  box.workspace?.onRoute();
}

function cycle(delta: number): void {
  if (!allowed()) return;
  const count = box.session.tabs.length;
  if (count === 0) return;
  const current = box.session.tabs.findIndex((tab) => tab.id === box.session.activeId);
  const index = (current + delta + count) % count;
  const tab = box.session.tabs[index];
  if (!tab) return;
  moveTo(tab.id, false);
}

function activateNumber(digit: number): void {
  if (!allowed()) return;
  const index = digit === 9 ? box.session.tabs.length - 1 : digit - 1;
  const tab = box.session.tabs[index];
  if (!tab) return;
  moveTo(tab.id, false);
}

function onKey(event: KeyboardEvent): void {
  if (!isTauri()) return;
  if (event.altKey && !isMod(event) && event.key === 'ArrowLeft') {
    event.preventDefault();
    step(-1);
    return;
  }
  if (event.altKey && !isMod(event) && event.key === 'ArrowRight') {
    event.preventDefault();
    step(1);
    return;
  }
  if (!isMod(event) || event.altKey) return;
  const which = bracket(event);
  if (which && !event.shiftKey) {
    event.preventDefault();
    step(which === 'left' ? -1 : 1);
    return;
  }
  if (which && event.shiftKey) {
    event.preventDefault();
    cycle(which === 'left' ? -1 : 1);
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    cycle(event.shiftKey ? -1 : 1);
    return;
  }
  if (!event.shiftKey && event.key.length === 1 && event.key >= '1' && event.key <= '9') {
    event.preventDefault();
    activateNumber(Number(event.key));
    return;
  }

}

function isMod(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function bracket(event: KeyboardEvent): 'left' | 'right' | null {
  if (event.code === 'BracketLeft' || event.key === '[' || event.key === '{') return 'left';
  if (event.code === 'BracketRight' || event.key === ']' || event.key === '}') return 'right';
  return null;
}

function tabIds(): string[] {
  return box.session.tabs.map((tab) => tab.id);
}

function closeMany(ids: string[]): void {
  for (const id of ids) closeTab(id);
}

function duplicateTab(id: string): void {
  const source = box.session.tabs.find((tab) => tab.id === id);
  if (!source || !allowed() || box.session.tabs.length >= MAX_TABS) return;
  const current = active();
  const saved = current ? snapshot(current) : null;
  const copy = freshTab(source.href, source.title);
  const tabs = box.session.tabs.map((item) => (saved && item.id === saved.id ? saved : item));
  box.session = { tabs: [...tabs, copy], activeId: copy.id };
  reveal(copy);
  persist();
  paint();
  box.workspace?.onRoute();
}

let reloading = false;

async function reloadTab(id: string): Promise<void> {
  const host = box.root;
  const tab = box.session.tabs.find(item => item.id === id);
  if (!host || !tab || reloading || !allowed()) return;
  reloading = true;
  const previous = host.inert;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  host.inert = true;
  host.querySelector('[data-desktop-reload-error]')?.remove();
  try {
    await flushDesktop();
    const current = active();
    if (current) box.session = withTab(box.session, current.id, snapshot(current));
    box.session.activeId = id;
    nativeReplace(tab.href);
    persist();
    location.reload();
  } catch (error) {
    host.inert = previous;
    reloading = false;
    const notice = document.createElement('div');
    notice.className = 'desktop-close-notice';
    notice.setAttribute('data-desktop-reload-error', '');
    notice.setAttribute('role', 'alert');
    notice.textContent = 'Impossible d’enregistrer avant le rechargement. ' + (error instanceof Error ? error.message : String(error));
    host.append(notice);
  }
}

function runTabMenuAction(action: TabMenuAction, id: string): void {
  const ids = tabIds();
  const index = ids.indexOf(id);
  if (action === 'copy-link') {
    const tab = box.session.tabs.find((item) => item.id === id);
    if (tab && box.mountedWorkspace) {
      const url = new URL(tab.href);
      const id = url.searchParams.get('page');
      if (id) void navigator.clipboard?.writeText(workspacePageLink(box.mountedWorkspace, id, pageView(url)));
    }
    return;
  }
  if (action === 'reload') { void reloadTab(id); return; }
  if (action === 'duplicate') { duplicateTab(id); return; }
  if (action === 'close') { closeTab(id); return; }
  if (action === 'close-others') { closeMany(ids.filter((other) => other !== id)); return; }
  if (action === 'close-left') { closeMany(ids.slice(0, Math.max(0, index))); return; }
  if (action === 'close-right') { closeMany(ids.slice(index + 1)); }
}

function closeTabMenu(): void {
  box.root?.querySelector('[data-desktop-tab-menu]')?.remove();
}

function openTabMenu(id: string, x: number, y: number): void {
  closeTabMenu();
  const tab = box.session.tabs.find((item) => item.id === id);
  if (!tab || !box.root) return;
  const menu = document.createElement('div');
  menu.setAttribute('data-desktop-tab-menu', '');
  menu.setAttribute('role', 'menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  for (const item of buildTabMenuItems({ tabId: id, tabIds: tabIds(), href: tab.href })) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    button.disabled = item.disabled;
    if (item.separated) button.setAttribute('data-desktop-menu-group', '');
    button.addEventListener('click', () => { closeTabMenu(); runTabMenuAction(item.action, id); });
    menu.append(button);
  }
  box.root.append(menu);
  const box_ = menu.getBoundingClientRect();
  if (box_.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - box_.width - 8)}px`;
  if (box_.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - box_.height - 8)}px`;
  const dismiss = (event: Event): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    closeTabMenu();
    document.removeEventListener('pointerdown', dismiss, true);
  };
  document.addEventListener('pointerdown', dismiss, true);
}

function onContextMenu(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const tab = target.closest('[data-desktop-tab]');
  const id = tab instanceof HTMLElement ? (tab.dataset.desktopTab ?? '') : '';
  if (!id) return;
  event.preventDefault();
  openTabMenu(id, event.clientX, event.clientY);
}

function onClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const action = target.closest('[data-desktop-action]');
  if (!(action instanceof HTMLElement)) return;
  const name = action.dataset.desktopAction ?? '';
  const tabId = action.dataset.desktopTab ?? '';
  if (name === 'new-tab') createTab();
  if (name === 'new-page') openPage();
  if (name === 'sidebar') box.workspace?.toggleSidebar();
  if (name === 'back') step(-1);
  if (name === 'forward') step(1);
  if (name === 'close') closeTab(tabId);
  if (name === 'activate') moveTo(tabId, true);
}

function persist(): void {
  if (!isTauri()) return;
  sessionStorage.setItem(tabKey(), JSON.stringify(box.session));
}

function paint(): void {
  const root = box.root;
  if (!root?.isConnected) return;
  const header = root.querySelector('[data-desktop-tabstrip]');
  if (!(header instanceof HTMLElement)) return;
  const navigation = document.createElement('div');
  navigation.setAttribute('data-desktop-navigation', '');
  navigation.append(backButton(), forwardButton());
  header.replaceChildren(leading(), navigation, tablist(), newTabButton(), trailing());
  const current = header.querySelector('[role="tab"][aria-selected="true"]');
  if (current instanceof HTMLElement && typeof current.scrollIntoView === 'function') {
    current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function strip(): HTMLElement {
  const header = document.createElement('header');
  header.setAttribute('data-desktop-tabstrip', '');
  // Tauri's deep drag region covers empty gaps; buttons and tabs remain interactive.
  header.setAttribute('data-tauri-drag-region', 'deep');
  return header;
}

function leading(): HTMLElement {
  const cluster = document.createElement('div');
  cluster.setAttribute('data-desktop-leading', '');
  const traffic = document.createElement('div');
  traffic.setAttribute('data-desktop-traffic', '');
  traffic.setAttribute('data-tauri-drag-region', '');
  traffic.style.width = isTauri() ? '83px' : '11px';
  const drag = document.createElement('div');
  drag.setAttribute('data-desktop-leading-drag', '');
  drag.setAttribute('data-tauri-drag-region', '');
  cluster.append(traffic, iconButton('sidebar', 'Afficher ou masquer la barre latérale', sidebarIcon()), drag, iconButton('new-page', 'Nouvelle page', plusIcon()));
  return cluster;
}

function trailing(): HTMLElement {
  const drag = document.createElement('div');
  drag.setAttribute('data-desktop-trailing-drag', '');
  drag.setAttribute('data-tauri-drag-region', '');
  return drag;
}

function backButton(): HTMLButtonElement {
  const tab = active();
  const button = iconButton('back', 'Page précédente', chevron('M10 3.5 5 8l5 4.5'));
  button.disabled = !tab || tab.index <= 0;
  return button;
}

function forwardButton(): HTMLButtonElement {
  const tab = active();
  const button = iconButton('forward', 'Page suivante', chevron('M6 3.5 11 8l-5 4.5'));
  button.disabled = !tab || tab.index >= tab.entries.length - 1;
  return button;
}

function newTabButton(): HTMLButtonElement {
  const button = iconButton('new-tab', 'Nouvel onglet', plusIcon());
  button.title = 'Nouvel onglet (⌘T)';
  return button;
}

function tablist(): HTMLElement {
  const list = document.createElement('div');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', "Onglets de l'application");
  const showClose = box.session.tabs.length > 1;
  box.session.tabs.forEach((tab) => {
    list.append(tabView(tab, tab.id === box.session.activeId, showClose));
  });
  return list;
}

function tabView(tab: Tab, selected: boolean, showClose: boolean): HTMLElement {
  const node = document.createElement('div');
  node.setAttribute('role', 'tab');
  node.setAttribute('aria-selected', selected ? 'true' : 'false');
  node.tabIndex = selected ? 0 : -1;
  node.dataset.desktopAction = 'activate';
  node.dataset.desktopTab = tab.id;
  node.append(tabIcon(tab.icon), label(tab.title));
  if (showClose) node.append(closeButton(tab));
  return node;
}

function label(title: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.setAttribute('data-desktop-tab-label', '');
  node.textContent = title;
  return node;
}

function tabIcon(icon: string): HTMLSpanElement {
  const node = document.createElement('span');
  if (icon === '') {
    node.setAttribute('data-desktop-tab-icon', 'document');
    node.append(documentGlyph());
    return node;
  }
  node.setAttribute('data-desktop-tab-icon', '');
  renderPageIcon(node, icon);
  return node;
}

function closeButton(tab: Tab): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('data-desktop-close', '');
  button.dataset.desktopAction = 'close';
  button.dataset.desktopTab = tab.id;
  button.setAttribute('aria-label', `Fermer ${tab.title}`);
  button.append(crossIcon());
  return button;
}

function iconButton(action: string, name: string, icon: Node): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.desktopAction = action;
  button.setAttribute('aria-label', name);
  button.append(icon);
  return button;
}

function svg(): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', '16');
  node.setAttribute('height', '16');
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function stroke(node: SVGElement, d: string): void {
  node.setAttribute('d', d);
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.5');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
}

function chevron(d: string): SVGSVGElement {
  const node = svg();
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(path, d);
  node.append(path);
  return node;
}

function plusIcon(): SVGSVGElement {
  const node = svg();
  ['M8 3.5v9', 'M3.5 8h9'].forEach((d) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stroke(path, d);
    node.append(path);
  });
  return node;
}

function crossIcon(): SVGSVGElement {
  const node = svg();
  ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'].forEach((d) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stroke(path, d);
    node.append(path);
  });
  return node;
}

function sidebarIcon(): SVGSVGElement {
  const node = svg();
  const frame = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(frame, 'M2.5 3.5h11v9h-11z');
  const bar = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(bar, 'M6 3.5v9');
  node.append(frame, bar);
  return node;
}

function documentGlyph(): SVGSVGElement {
  const node = svg();
  const pageShape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(pageShape, 'M4 2.5h5.2L12.5 6v7.5H4z');
  const fold = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(fold, 'M9.2 2.5V6H12.5');
  node.append(pageShape, fold);
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNumberList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}

function parseTab(value: unknown): Tab | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.href !== 'string') return null;
  if (typeof value.title !== 'string' || typeof value.icon !== 'string') return null;
  if (typeof value.scrollY !== 'number' || typeof value.index !== 'number') return null;
  if (!isStringList(value.entries) || !isNumberList(value.scrollPositions)) return null;
  if (!sameOrigin(value.href) || value.entries.length === 0) return null;
  const overflow = Math.max(0, value.entries.length - MAX_HISTORY);
  const entries = value.entries.slice(overflow);
  const scrolls = alignedScrolls(value.scrollPositions, value.entries.length, entries.length);
  const index = Math.min(Math.max(0, value.index - overflow), entries.length - 1);
  const href = entries[index] ?? value.href;
  return {
    id: value.id,
    href,
    title: readable(value.title),
    icon: value.icon,
    scrollY: value.scrollY,
    entries,
    scrollPositions: scrolls,
    index,
  };
}

function alignedScrolls(scrolls: number[], entryCount: number, kept: number): number[] {
  if (scrolls.length !== entryCount) return Array.from({ length: kept }, () => 0);
  return scrolls.slice(scrolls.length - kept);
}

function load(raw: string | null): Session | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.tabs) || typeof parsed.activeId !== 'string') return null;
    const tabs = parsed.tabs.map(parseTab).filter((tab): tab is Tab => tab !== null).slice(0, MAX_TABS);
    if (tabs.length === 0) return null;
    const activeId = tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : (tabs[0]?.id ?? '');
    return { tabs, activeId };
  } catch {
    return null;
  }
}
||||||| f8ef3c6b39
=======
import { renderPageIcon } from '../../src/shell/page-icon';
import { activeWorkspace, workspaceKey } from './workspace-registry';
import { createWorkspace, type Workspace } from './workspace';
import { applyAppearance, readAppearance, watchSystemAppearance } from './settings';

import { buildTabMenuItems, pageLinkFor, type TabMenuAction } from './tab-menu';
import { applyFavicon } from './tab-identity';

const tabKey = (): string => workspaceKey(activeWorkspace()) === 'local:default' ? 'blok:window-tabs:v1' : `blok:window-tabs:v1:${workspaceKey(activeWorkspace())}`;
const MAX_TABS = 20;
const MAX_HISTORY = 100;

interface Tab {
  id: string;
  href: string;
  title: string;
  icon: string;
  scrollY: number;
  entries: string[];
  scrollPositions: number[];
  index: number;
}

interface Session {
  tabs: Tab[];
  activeId: string;
}

const natives = {
  push: History.prototype.pushState,
  replace: History.prototype.replaceState,
};

const installed = { history: false, title: false, keys: false, menu: false };

const slot: {
  record: (mode: 'push' | 'replace', href: string) => void;
  syncTitle: () => void;
  onKey: (event: KeyboardEvent) => void;
} = {
  record: () => undefined,
  syncTitle: () => undefined,
  onKey: () => undefined,
};

const box: {
  root: HTMLElement | null;
  session: Session;
  canLeave: () => boolean;
  workspace: Workspace | null;
} = {
  root: null,
  session: { tabs: [], activeId: '' },
  canLeave: () => true,
  workspace: null,
};

export async function flushDesktop(): Promise<void> { await box.workspace?.flush(); }

export function setCanLeave(guard: () => boolean): void {
  box.canLeave = guard;
}

export function mountDesktop(root: HTMLElement): void {
  install();
  box.root = root;
  root.setAttribute('data-desktop-shell', '');
  applyAppearance(root, readAppearance());
  watchSystemAppearance(root);
  root.toggleAttribute('data-tauri', isTauri());
  box.session = isTauri() ? boot() : { tabs: [], activeId: '' };
  const current = active();
  if (current && current.href !== location.href) nativeReplace(current.href);
  if (current && document.title !== current.title) document.title = current.title;
  applyFavicon(current?.icon);
  box.workspace = createWorkspace((width) => {
    root.style.setProperty('--desktop-sidebar-width', `${Math.max(isTauri() ? 156 : 84, width)}px`);
  }, syncPageIcon);
  root.replaceChildren(...(isTauri() ? [strip(), box.workspace.element] : [box.workspace.element]));
  root.addEventListener('click', onClick);
  root.addEventListener('contextmenu', onContextMenu);
  slot.record = record;
  slot.syncTitle = syncTitle;
  slot.onKey = onKey;
  persist();
  paint();
  root.addEventListener('blok:desktop-select-workspace', (event) => {
    const ref = (event as CustomEvent).detail;
    void box.workspace?.flush().then(async () => { const { selectWorkspace } = await import('./workspace-registry'); selectWorkspace(ref); }).catch((error: unknown) => window.alert(String(error)));
  });
  void box.workspace.start();
}

function install(): void {
  installKeys();
  if (isTauri()) {
    installHistory();
    installTitle();
    installMenu();
  }
}

function installHistory(): void {
  if (installed.history) return;
  installed.history = true;
  const pushState: History['pushState'] = function pushState(this: History, data, unused, url) {
    if (!isTauri()) return natives.push.call(this, data, unused, url);
    void unused;
    const href = resolveHref(url);
    natives.replace.call(this, data, '', url);
    slot.record('push', href);
  };
  const replaceState: History['replaceState'] = function replaceState(this: History, data, unused, url) {
    if (!isTauri()) return natives.replace.call(this, data, unused, url);
    void unused;
    const href = resolveHref(url);
    natives.replace.call(this, data, '', url);
    slot.record('replace', href);
  };
  History.prototype.pushState = pushState;
  History.prototype.replaceState = replaceState;
}

function installTitle(): void {
  if (installed.title) return;
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
  if (!desc || !desc.set || !desc.get || !desc.configurable) return;
  installed.title = true;
  const get = desc.get;
  const set = desc.set;
  Object.defineProperty(Document.prototype, 'title', {
    configurable: true,
    enumerable: desc.enumerable === true,
    get() {
      return get.call(this);
    },
    set(value: string) {
      set.call(this, value);
      slot.syncTitle();
    },
  });
}

function installKeys(): void {
  if (installed.keys) return;
  installed.keys = true;
  window.addEventListener('keydown', (event) => {
    slot.onKey(event);
  });
  window.addEventListener('popstate', () => {
    onPop();
  });
}

function installMenu(): void {
  if (installed.menu) return;
  installed.menu = true;
  window.addEventListener('blok:desktop-new-tab', () => {
    if (isTauri()) createTab();
  });
  window.addEventListener('blok:desktop-close-tab', () => {
    if (isTauri()) closeActive();
  });
}

function boot(): Session {
  const restored = load(sessionStorage.getItem(tabKey()));
  const requested = new URL(location.href);
  const page = requested.searchParams.get('page');
  if (!restored || !page) return restored ?? freshSession();
  // An explicit page link takes precedence over the previously selected tab.
  const existing = restored.tabs.find((tab) => {
    const url = new URL(tab.href);
    return url.pathname === requested.pathname && url.searchParams.get('page') === page;
  });
  if (existing) {
    existing.href = requested.href;
    existing.entries[existing.index] = requested.href;
    restored.activeId = existing.id;
  } else {
    const opened = freshTab(requested.href, 'Nouvelle page');
    restored.tabs.push(opened);
    restored.tabs = restored.tabs.slice(-MAX_TABS);
    restored.activeId = opened.id;
  }
  return restored;
}

function freshSession(): Session {
  const href = location.href;
  const tab = freshTab(href, readable(document.title));
  return { tabs: [tab], activeId: tab.id };
}

function freshTab(href: string, title: string): Tab {
  return {
    id: crypto.randomUUID(),
    href,
    title,
    icon: '',
    scrollY: 0,
    entries: [href],
    scrollPositions: [0],
    index: 0,
  };
}

function active(): Tab | null {
  return box.session.tabs.find((tab) => tab.id === box.session.activeId) ?? null;
}

function allowed(): boolean {
  return box.canLeave();
}

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

function closeEditorWindow(): void {
  const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
  if (!isRecord(internals)) return;
  const invoke: unknown = internals.invoke;
  if (typeof invoke !== 'function') return;
  void Promise.resolve(Reflect.apply(invoke, internals, ['close_editor_window', {}]));
}

function readable(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') return 'Nouvelle page';
  return trimmed;
}

function homeHref(): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  return url.href;
}

function resolveHref(url: string | URL | null | undefined): string {
  if (url === null || url === undefined) return location.href;
  return new URL(url, location.href).href;
}

function sameOrigin(href: string): boolean {
  try {
    return new URL(href).origin === location.origin;
  } catch {
    return false;
  }
}

function nativeReplace(href: string): void {
  natives.replace.call(history, null, '', href);
}

function withTab(session: Session, id: string, next: Tab): Session {
  return {
    activeId: session.activeId,
    tabs: session.tabs.map((tab) => (tab.id === id ? next : tab)),
  };
}

function snapshot(tab: Tab): Tab {
  const scrollY = window.scrollY;
  return {
    ...tab,
    scrollY,
    scrollPositions: tab.scrollPositions.map((value, i) => (i === tab.index ? scrollY : value)),
  };
}

function pushed(tab: Tab, href: string, scrollY: number): Tab {
  const kept = tab.entries.slice(0, tab.index + 1);
  const scrolls = tab.scrollPositions.slice(0, tab.index + 1).map((value, i) => {
    return i === tab.index ? scrollY : value;
  });
  return trimmed(tab, [...kept, href], [...scrolls, 0]);
}

function replaced(tab: Tab, href: string): Tab {
  return {
    ...tab,
    href,
    entries: tab.entries.map((entry, i) => (i === tab.index ? href : entry)),
  };
}

function trimmed(tab: Tab, entries: string[], scrollPositions: number[]): Tab {
  const overflow = entries.length - MAX_HISTORY;
  if (overflow <= 0) {
    return { ...tab, href: entries[entries.length - 1] ?? tab.href, entries, scrollPositions, index: entries.length - 1, scrollY: 0 };
  }
  const nextEntries = entries.slice(overflow);
  const nextScrolls = scrollPositions.slice(overflow);
  return {
    ...tab,
    href: nextEntries[nextEntries.length - 1] ?? tab.href,
    entries: nextEntries,
    scrollPositions: nextScrolls,
    index: nextEntries.length - 1,
    scrollY: 0,
  };
}

function record(mode: 'push' | 'replace', href: string): void {
  const tab = active();
  if (!tab || !sameOrigin(href)) return;
  const next = mode === 'push' ? pushed(tab, href, window.scrollY) : replaced(tab, href);
  box.session = withTab(box.session, tab.id, next);
  if (mode === 'push') window.scrollTo(0, 0);
  persist();
  paint();
  box.workspace?.onRoute();
}

function step(delta: number): void {
  if (!allowed()) return;
  const tab = active();
  if (!tab) return;
  const index = tab.index + delta;
  if (index < 0 || index >= tab.entries.length) return;
  const scrollPositions = tab.scrollPositions.map((value, i) => (i === tab.index ? window.scrollY : value));
  const href = tab.entries[index] ?? tab.href;
  const scrollY = scrollPositions[index] ?? 0;
  const next: Tab = { ...tab, scrollPositions, index, href, scrollY };
  box.session = withTab(box.session, tab.id, next);
  nativeReplace(href);
  window.scrollTo(0, scrollY);
  persist();
  paint();
  box.workspace?.onRoute();
}

function moveTo(id: string, check: boolean): void {
  if (check && !allowed()) return;
  const current = active();
  const next = box.session.tabs.find((tab) => tab.id === id);
  if (!current || !next || next.id === current.id) return;
  const saved = snapshot(current);
  box.session = {
    activeId: next.id,
    tabs: box.session.tabs.map((tab) => (tab.id === saved.id ? saved : tab)),
  };
  nativeReplace(next.href);
  window.scrollTo(0, next.scrollY);
  if (document.title !== next.title) document.title = next.title;
  applyFavicon(next.icon);
  persist();
  paint();
  box.workspace?.onRoute();
}

function createTab(): void {
  if (!allowed()) return;
  if (box.session.tabs.length >= MAX_TABS) return;
  const current = active();
  const saved = current ? snapshot(current) : null;
  const href = homeHref();
  const tab = freshTab(href, 'Nouvelle page');
  const tabs = box.session.tabs.map((item) => (saved && item.id === saved.id ? saved : item));
  box.session = { tabs: [...tabs, tab], activeId: tab.id };
  nativeReplace(href);
  window.scrollTo(0, 0);
  if (document.title !== 'Nouvelle page') document.title = 'Nouvelle page';
  applyFavicon(tab.icon);
  persist();
  paint();
  box.workspace?.onRoute();
}

function closeActive(): void {
  const tab = active();
  if (!tab) return;
  closeTab(tab.id);
}

function closeTab(id: string): void {
  if (!allowed()) return;
  if (box.session.tabs.length <= 1) {
    if (isTauri()) closeEditorWindow();
    return;
  }
  const index = box.session.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const wasActive = box.session.activeId === id;
  const neighbor = box.session.tabs[index + 1] ?? box.session.tabs[index - 1];
  const tabs = box.session.tabs.filter((tab) => tab.id !== id);
  const activeId = wasActive ? (neighbor?.id ?? '') : box.session.activeId;
  box.session = { tabs, activeId };
  const next = active();
  if (wasActive && next) reveal(next);
  persist();
  paint();
  box.workspace?.onRoute();
}

function reveal(next: Tab): void {
  nativeReplace(next.href);
  window.scrollTo(0, next.scrollY);
  if (document.title !== next.title) document.title = next.title;
  applyFavicon(next.icon);
}

function openPage(): void {
  box.workspace?.createPage();
}

function syncTitle(): void {
  const tab = active();
  if (!tab) return;
  const title = readable(document.title);
  if (tab.title === title) return;
  box.session = withTab(box.session, tab.id, { ...tab, title });
  persist();
  paint();
}

function syncPageIcon(pageId: string, icon: string): void {
  // The web has no tab strip, so the URL — not a tab — says what is on screen.
  if (pageId === pageOf(location.href)) applyFavicon(icon);
  let changed = false;
  const tabs = box.session.tabs.map((tab) => {
    if (new URL(tab.href).searchParams.get('page') !== pageId || tab.icon === icon) return tab;
    changed = true;
    return { ...tab, icon };
  });
  if (!changed) return;
  box.session = { ...box.session, tabs };
  persist();
  paint();
}

function pageOf(href: string): string | null {
  try { return new URL(href).searchParams.get('page'); } catch { return null; }
}

function onPop(): void {
  if (!isTauri()) {
    box.workspace?.onRoute();
    return;
  }
  const tab = active();
  if (!tab) return;
  const href = location.href;
  const found = tab.entries.lastIndexOf(href);
  const scrollY = found >= 0 ? (tab.scrollPositions[found] ?? tab.scrollY) : tab.scrollY;
  const next = found >= 0
    ? { ...tab, index: found, href, scrollY }
    : replaced(tab, href);
  box.session = withTab(box.session, tab.id, next);
  if (found >= 0) window.scrollTo(0, scrollY);
  persist();
  paint();
  box.workspace?.onRoute();
}

function cycle(delta: number): void {
  if (!allowed()) return;
  const count = box.session.tabs.length;
  if (count === 0) return;
  const current = box.session.tabs.findIndex((tab) => tab.id === box.session.activeId);
  const index = (current + delta + count) % count;
  const tab = box.session.tabs[index];
  if (!tab) return;
  moveTo(tab.id, false);
}

function activateNumber(digit: number): void {
  if (!allowed()) return;
  const index = digit === 9 ? box.session.tabs.length - 1 : digit - 1;
  const tab = box.session.tabs[index];
  if (!tab) return;
  moveTo(tab.id, false);
}

function onKey(event: KeyboardEvent): void {
  if (!isTauri()) return;
  if (event.altKey && !isMod(event) && event.key === 'ArrowLeft') {
    event.preventDefault();
    step(-1);
    return;
  }
  if (event.altKey && !isMod(event) && event.key === 'ArrowRight') {
    event.preventDefault();
    step(1);
    return;
  }
  if (!isMod(event) || event.altKey) return;
  const which = bracket(event);
  if (which && !event.shiftKey) {
    event.preventDefault();
    step(which === 'left' ? -1 : 1);
    return;
  }
  if (which && event.shiftKey) {
    event.preventDefault();
    cycle(which === 'left' ? -1 : 1);
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    cycle(event.shiftKey ? -1 : 1);
    return;
  }
  if (!event.shiftKey && event.key.length === 1 && event.key >= '1' && event.key <= '9') {
    event.preventDefault();
    activateNumber(Number(event.key));
    return;
  }

}

function isMod(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function bracket(event: KeyboardEvent): 'left' | 'right' | null {
  if (event.code === 'BracketLeft' || event.key === '[' || event.key === '{') return 'left';
  if (event.code === 'BracketRight' || event.key === ']' || event.key === '}') return 'right';
  return null;
}

function tabIds(): string[] {
  return box.session.tabs.map((tab) => tab.id);
}

function closeMany(ids: string[]): void {
  for (const id of ids) closeTab(id);
}

function duplicateTab(id: string): void {
  const source = box.session.tabs.find((tab) => tab.id === id);
  if (!source || !allowed() || box.session.tabs.length >= MAX_TABS) return;
  const current = active();
  const saved = current ? snapshot(current) : null;
  const copy = freshTab(source.href, source.title);
  const tabs = box.session.tabs.map((item) => (saved && item.id === saved.id ? saved : item));
  box.session = { tabs: [...tabs, copy], activeId: copy.id };
  reveal(copy);
  persist();
  paint();
  box.workspace?.onRoute();
}

function runTabMenuAction(action: TabMenuAction, id: string): void {
  const ids = tabIds();
  const index = ids.indexOf(id);
  if (action === 'copy-link') {
    const tab = box.session.tabs.find((item) => item.id === id);
    const link = tab ? pageLinkFor(tab.href) : null;
    if (link) void navigator.clipboard?.writeText(link);
    return;
  }
  if (action === 'reload') { moveTo(id, false); box.workspace?.onRoute(); return; }
  if (action === 'duplicate') { duplicateTab(id); return; }
  if (action === 'close') { closeTab(id); return; }
  if (action === 'close-others') { closeMany(ids.filter((other) => other !== id)); return; }
  if (action === 'close-left') { closeMany(ids.slice(0, Math.max(0, index))); return; }
  if (action === 'close-right') { closeMany(ids.slice(index + 1)); }
}

function closeTabMenu(): void {
  box.root?.querySelector('[data-desktop-tab-menu]')?.remove();
}

function openTabMenu(id: string, x: number, y: number): void {
  closeTabMenu();
  const tab = box.session.tabs.find((item) => item.id === id);
  if (!tab || !box.root) return;
  const menu = document.createElement('div');
  menu.setAttribute('data-desktop-tab-menu', '');
  menu.setAttribute('role', 'menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  for (const item of buildTabMenuItems({ tabId: id, tabIds: tabIds(), href: tab.href })) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    button.disabled = item.disabled;
    if (item.separated) button.setAttribute('data-desktop-menu-group', '');
    button.addEventListener('click', () => { closeTabMenu(); runTabMenuAction(item.action, id); });
    menu.append(button);
  }
  box.root.append(menu);
  const box_ = menu.getBoundingClientRect();
  if (box_.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - box_.width - 8)}px`;
  if (box_.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - box_.height - 8)}px`;
  const dismiss = (event: Event): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    closeTabMenu();
    document.removeEventListener('pointerdown', dismiss, true);
  };
  document.addEventListener('pointerdown', dismiss, true);
}

function onContextMenu(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const tab = target.closest('[data-desktop-tab]');
  const id = tab instanceof HTMLElement ? (tab.dataset.desktopTab ?? '') : '';
  if (!id) return;
  event.preventDefault();
  openTabMenu(id, event.clientX, event.clientY);
}

function onClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const action = target.closest('[data-desktop-action]');
  if (!(action instanceof HTMLElement)) return;
  const name = action.dataset.desktopAction ?? '';
  const tabId = action.dataset.desktopTab ?? '';
  if (name === 'new-tab') createTab();
  if (name === 'new-page') openPage();
  if (name === 'sidebar') box.workspace?.toggleSidebar();
  if (name === 'back') step(-1);
  if (name === 'forward') step(1);
  if (name === 'close') closeTab(tabId);
  if (name === 'activate') moveTo(tabId, true);
}

function persist(): void {
  if (!isTauri()) return;
  sessionStorage.setItem(tabKey(), JSON.stringify(box.session));
}

function paint(): void {
  const root = box.root;
  if (!root?.isConnected) return;
  const header = root.querySelector('[data-desktop-tabstrip]');
  if (!(header instanceof HTMLElement)) return;
  const navigation = document.createElement('div');
  navigation.setAttribute('data-desktop-navigation', '');
  navigation.append(backButton(), forwardButton());
  header.replaceChildren(leading(), navigation, tablist(), newTabButton(), trailing());
  const current = header.querySelector('[role="tab"][aria-selected="true"]');
  if (current instanceof HTMLElement && typeof current.scrollIntoView === 'function') {
    current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function strip(): HTMLElement {
  const header = document.createElement('header');
  header.setAttribute('data-desktop-tabstrip', '');
  // Tauri's deep drag region covers empty gaps; buttons and tabs remain interactive.
  header.setAttribute('data-tauri-drag-region', 'deep');
  return header;
}

function leading(): HTMLElement {
  const cluster = document.createElement('div');
  cluster.setAttribute('data-desktop-leading', '');
  const traffic = document.createElement('div');
  traffic.setAttribute('data-desktop-traffic', '');
  traffic.setAttribute('data-tauri-drag-region', '');
  traffic.style.width = isTauri() ? '83px' : '11px';
  const drag = document.createElement('div');
  drag.setAttribute('data-desktop-leading-drag', '');
  drag.setAttribute('data-tauri-drag-region', '');
  cluster.append(traffic, iconButton('sidebar', 'Afficher ou masquer la barre latérale', sidebarIcon()), drag, iconButton('new-page', 'Nouvelle page', plusIcon()));
  return cluster;
}

function trailing(): HTMLElement {
  const drag = document.createElement('div');
  drag.setAttribute('data-desktop-trailing-drag', '');
  drag.setAttribute('data-tauri-drag-region', '');
  return drag;
}

function backButton(): HTMLButtonElement {
  const tab = active();
  const button = iconButton('back', 'Page précédente', chevron('M10 3.5 5 8l5 4.5'));
  button.disabled = !tab || tab.index <= 0;
  return button;
}

function forwardButton(): HTMLButtonElement {
  const tab = active();
  const button = iconButton('forward', 'Page suivante', chevron('M6 3.5 11 8l-5 4.5'));
  button.disabled = !tab || tab.index >= tab.entries.length - 1;
  return button;
}

function newTabButton(): HTMLButtonElement {
  const button = iconButton('new-tab', 'Nouvel onglet', plusIcon());
  button.title = 'Nouvel onglet (⌘T)';
  return button;
}

function tablist(): HTMLElement {
  const list = document.createElement('div');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', "Onglets de l'application");
  const showClose = box.session.tabs.length > 1;
  box.session.tabs.forEach((tab) => {
    list.append(tabView(tab, tab.id === box.session.activeId, showClose));
  });
  return list;
}

function tabView(tab: Tab, selected: boolean, showClose: boolean): HTMLElement {
  const node = document.createElement('div');
  node.setAttribute('role', 'tab');
  node.setAttribute('aria-selected', selected ? 'true' : 'false');
  node.tabIndex = selected ? 0 : -1;
  node.dataset.desktopAction = 'activate';
  node.dataset.desktopTab = tab.id;
  node.append(tabIcon(tab.icon), label(tab.title));
  if (showClose) node.append(closeButton(tab));
  return node;
}

function label(title: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.setAttribute('data-desktop-tab-label', '');
  node.textContent = title;
  return node;
}

function tabIcon(icon: string): HTMLSpanElement {
  const node = document.createElement('span');
  if (icon === '') {
    node.setAttribute('data-desktop-tab-icon', 'document');
    node.append(documentGlyph());
    return node;
  }
  node.setAttribute('data-desktop-tab-icon', '');
  renderPageIcon(node, icon);
  return node;
}

function closeButton(tab: Tab): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('data-desktop-close', '');
  button.dataset.desktopAction = 'close';
  button.dataset.desktopTab = tab.id;
  button.setAttribute('aria-label', `Fermer ${tab.title}`);
  button.append(crossIcon());
  return button;
}

function iconButton(action: string, name: string, icon: Node): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.desktopAction = action;
  button.setAttribute('aria-label', name);
  button.append(icon);
  return button;
}

function svg(): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', '16');
  node.setAttribute('height', '16');
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function stroke(node: SVGElement, d: string): void {
  node.setAttribute('d', d);
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.5');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
}

function chevron(d: string): SVGSVGElement {
  const node = svg();
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(path, d);
  node.append(path);
  return node;
}

function plusIcon(): SVGSVGElement {
  const node = svg();
  ['M8 3.5v9', 'M3.5 8h9'].forEach((d) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stroke(path, d);
    node.append(path);
  });
  return node;
}

function crossIcon(): SVGSVGElement {
  const node = svg();
  ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'].forEach((d) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stroke(path, d);
    node.append(path);
  });
  return node;
}

function sidebarIcon(): SVGSVGElement {
  const node = svg();
  const frame = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(frame, 'M2.5 3.5h11v9h-11z');
  const bar = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(bar, 'M6 3.5v9');
  node.append(frame, bar);
  return node;
}

function documentGlyph(): SVGSVGElement {
  const node = svg();
  const pageShape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(pageShape, 'M4 2.5h5.2L12.5 6v7.5H4z');
  const fold = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke(fold, 'M9.2 2.5V6H12.5');
  node.append(pageShape, fold);
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNumberList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}

function parseTab(value: unknown): Tab | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.href !== 'string') return null;
  if (typeof value.title !== 'string' || typeof value.icon !== 'string') return null;
  if (typeof value.scrollY !== 'number' || typeof value.index !== 'number') return null;
  if (!isStringList(value.entries) || !isNumberList(value.scrollPositions)) return null;
  if (!sameOrigin(value.href) || value.entries.length === 0) return null;
  const overflow = Math.max(0, value.entries.length - MAX_HISTORY);
  const entries = value.entries.slice(overflow);
  const scrolls = alignedScrolls(value.scrollPositions, value.entries.length, entries.length);
  const index = Math.min(Math.max(0, value.index - overflow), entries.length - 1);
  const href = entries[index] ?? value.href;
  return {
    id: value.id,
    href,
    title: readable(value.title),
    icon: value.icon,
    scrollY: value.scrollY,
    entries,
    scrollPositions: scrolls,
    index,
  };
}

function alignedScrolls(scrolls: number[], entryCount: number, kept: number): number[] {
  if (scrolls.length !== entryCount) return Array.from({ length: kept }, () => 0);
  return scrolls.slice(scrolls.length - kept);
}

function load(raw: string | null): Session | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.tabs) || typeof parsed.activeId !== 'string') return null;
    const tabs = parsed.tabs.map(parseTab).filter((tab): tab is Tab => tab !== null).slice(0, MAX_TABS);
    if (tabs.length === 0) return null;
    const activeId = tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : (tabs[0]?.id ?? '');
    return { tabs, activeId };
  } catch {
    return null;
  }
}
>>>>>>> origin/fix/self-host-review
