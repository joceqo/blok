import {shellText} from './shell-i18n';
import {rememberShellLanguage, shellLocale} from './shell-i18n';
import { libraryPageId, libraryPageUrl, libraryUrl, libraryView, type LibraryView } from './library-route';
import { calendarUrl, editorUrl, isCalendarUrl } from './calendar-route';
import { whiteboardElementTool } from './whiteboard-element';
import { mountPageWhiteboard, whiteboardPlacementTune } from './page-whiteboard';
import { clearPageRoute, pageIdForWorkspaceLink, pageUrlForView, pageView, resolveWorkspacePageLink, webPageLink, workspacePageLink, type PageView } from './page-link';
import { navigationEdits, navigationFavorites, navigationRecents } from './navigation-preferences';
import { moveDestinations, PageMoveConflict } from './page-move';
import { openPageHistory } from './page-history';
import { openMovePicker, openPageSearch, openPageCreation, type CreationDestination } from './navigation-dialogs';
import { PopoverDesktop } from '@blok/popover';
import { customEmojiStore } from './custom-emojis';
import { createEmptyWorkspaceState } from './workspace-empty';
import { mountRemoteAssets } from './remote-assets';
import { Blok, defaultTools, type OutputData, type CollaborationStatusChangedPayload } from '@bloklabs/core/full';
import { Audio, Bookmark, File, Video, Callout, Code, Database, DatabaseComment, DatabaseRow, Divider, Image, Page, Quote, Table, TableOfContents, Toggle, type PageConfig } from '@bloklabs/core/tools';
import { createReactPageFrame } from './sidebar/sidebar-frame';
import { createPageFrame, type PageFrame, type ShellPage, type SidebarAction } from '@blok/sidebar';
import { type DesktopPage, type WorkspaceIndex } from './storage';
import { RepositoryHttpError, workspaceRepository } from './workspace-repository';
import { WorkspaceConflictError } from './workspace-merge';
import { documentSyncStatus } from './document-sync-status';
import { pageAccess } from './page-access';
import { CloudApiError } from './cloud/client';
import { openRemoteTrash } from './cloud/trash';
import type { TeamPageNavigation } from './cloud/teamspaces';
import { openPageSharing } from './cloud/page-sharing';
import { groupPagesBySection, sectionNames } from './page-section';
import { nextPageIcon } from './page-icon-sync';
import { applyFavicon, brandedTitle } from './tab-identity';
import { describeAccessLoss } from './access-friction';
import { activeWorkspace, selectWorkspace, workspaceKey, type WorkspaceRef } from './workspace-registry';
import { createDesktopFooter, readAppearance } from './settings';
import {
  buildWelcomeDocuments,
  seedWelcomeDocuments,
  hasWelcomeSeeded,
  markWelcomeSeeded,
  shouldSeedWelcome,
  welcomePageId,
} from './welcome-seed';
import { markdownImportAttempt } from './markdown-import-attempt';
import { COVER_GALLERY, readCoverFile, createAddCoverButton, createPageCover, isPageCover, trackPageHeaderHover, type PageCover } from './cover';
import { mountAgentAssistant, type AgentAssistantHandle } from '@blok/agent-assistant';
import { createAiClient, selectionKey } from './ai-client';
import { pageEditorAssistant } from './editor-assistant';
import { bindAssistantButton, createAssistantButton, createWorkspaceAssistant } from './assistant';
import { createPageToolbar, type PageBreadcrumbChoice, type PageBreadcrumbItem, type PageToolbar } from './page-toolbar';
import { bindTitleDateMention, titleDateLabel, type TitleDateMentionBinding } from './title-date-mention';
import { createFloatingToc, type FloatingToc } from './floating-toc';
import type { DateDisplayChange } from '@blok/date-editor';

const desktopTools = {
  ...defaultTools,
  whiteboardPlacement: whiteboardPlacementTune,
  whiteboardElement: whiteboardElementTool,
  paragraph: { ...defaultTools.paragraph, tunes: ['whiteboardPlacement'] },
  table: { class: Table },
  database: { class: Database },
  'database-row': { class: DatabaseRow },
  'database-comment': { class: DatabaseComment },
  // Writing about a codebase needs these: code carries Prism highlighting, line
  // numbers, language detection and mermaid; the rest are what an explanation is
  // built from — callouts for the "why", toggles for detail a reader can fold away.
  code: { class: Code },
  callout: { class: Callout },
  toggle: { class: Toggle },
  quote: { class: Quote },
  divider: { class: Divider },
  // A page about a UI needs to show it; an explanation long enough to scroll needs
  // its own map. Both ship in the core and were simply never named here.
  image: { class: Image },
  bookmark: { class: Bookmark },
  file: { class: File },
  audio: { class: Audio },
  video: { class: Video },
  table_of_contents: { class: TableOfContents },
};

export interface Workspace {
  element: HTMLElement;
  hasPage(id: string): boolean;
  start(): Promise<void>;
  flush(): Promise<void>;
  onRoute(): void;
  toggleSidebar(): void;
  createPage(parentId?: string | null): void;
}


function adoptRemoteFields(live: DesktopPage, remote: DesktopPage): void {
  const target = live as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    if (!(key in remote)) Reflect.deleteProperty(target, key);
  }
  Object.assign(live, remote);
}

export function createWorkspace(onLayout: (width: number) => void, onPageIcon: (id: string, icon: string) => void, options: { ref?: WorkspaceRef } = {}): Workspace {
  const ref = Object.freeze({... (options.ref ?? activeWorkspace())});
  const repository = workspaceRepository(ref);
  const favorites = navigationFavorites(ref);
  const recentPages = navigationRecents(ref);
  const edits = navigationEdits(ref);
  const pageUrl = (id: string, view?: PageView): string => workspacePageLink(ref, id, view);
  const emojis = customEmojiStore(ref);
  const pageIcon = (value: string) => /^(https?:|data:image\/|\/files\/)/i.test(value) ? {type: 'image' as const, url: value} : {type: 'emoji' as const, value};
  if (ref.kind === 'remote' && '__TAURI_INTERNALS__' in window) mountRemoteAssets(ref.server, repository.assetUrl);
  // L'interface ne savait dire qu'une chose : cet espace est-il en lecture seule ?
  // Elle dit désormais : cette page-ci l'est-elle. Le niveau vient de l'index, et
  // se réévalue à chaque fois qu'il est reçu.
  const ws: {
    access: ReturnType<typeof pageAccess>;
    index: WorkspaceIndex | null;
    editor: Blok | null;
    documentStatus?: CollaborationStatusChangedPayload;
    selection: number;
    frame: PageFrame & { setPagesError?(): void };
    coverRowObserver: MutationObserver | null;
    assistant: AgentAssistantHandle;
    pageCanvas: HTMLElement;
    footer: HTMLElement;
    pageToolbar: PageToolbar | null;
    refreshPagePresentation: (() => void) | null;
    titleDateMention: TitleDateMentionBinding | null;
    floatingToc: FloatingToc | null;
    currentId: string;
    generation: number;
    dateTimer: number | null;
    saveOrder: Promise<void>;
    pendingManifests: number;
    manifestFailed: boolean;
    manifestError?: unknown;
    refreshingManifest: boolean;
    metadataAction: boolean;
    movingPage: boolean;
    closeSearch: (() => void) | undefined;
  } = {
    access: pageAccess(ref, undefined),
    index: null,
    editor: null,
    selection: 0,
    frame: null as unknown as PageFrame,
    coverRowObserver: null,
    assistant: null as unknown as AgentAssistantHandle,
    pageCanvas: null as unknown as HTMLElement,
    footer: null as unknown as HTMLElement,
    pageToolbar: null,
    refreshPagePresentation: null,
    titleDateMention: null,
    floatingToc: null,
    currentId: '',
    generation: 0,
    dateTimer: null,
    saveOrder: Promise.resolve(),
    pendingManifests: 0,
    manifestFailed: false,
    refreshingManifest: false,
    metadataAction: false,
    movingPage: false,
    closeSearch: undefined,
  };
  let calendar: { destroy(): void } | undefined;
  let board: ReturnType<typeof mountPageWhiteboard> | undefined;
  let openingCalendar: number | undefined;
  let library: ReturnType<typeof import('./workspace-library').mountWorkspaceLibrary> | undefined;
  let openingLibrary: string | undefined;
  let libraryPage: string | null | undefined;
  let libraryRequest = 0;
  let pageSheet: ReturnType<typeof import('./library-page-peek').mountLibraryPageSheet> | undefined;
  let peekReturnFocus: HTMLElement | undefined;
  let libraryHistory: {ids: string[]; visits: Map<string, number | undefined>} | undefined;
  const currentLibrary = () => libraryView(new URL(location.href));
  const isCalendarRoute = (): boolean => isCalendarUrl(new URL(location.href));
  const ai = createAiClient(ref);
  let editAssistant: ReturnType<typeof pageEditorAssistant> | undefined;
  const activeEditable = (): boolean => !!ws.currentId && ws.currentId === pageFromUrl() &&
    ws.frame.element.isConnected && !ws.frame.element.inert && ws.access.canEdit(ws.currentId);
  const adoptIndex = (value: WorkspaceIndex): WorkspaceIndex => {
    const wasEditable = ws.access.canEdit(ws.currentId);
    ws.index = value;
    ws.access = pageAccess(ref, value.access);
    const editable = ws.access.canEdit(ws.currentId);
    if (ws.currentId && wasEditable !== editable) {
      ws.pageToolbar?.closeHistory();
      if (!editable) editAssistant?.cancel();
      const editor = ws.editor;
      if (editor) void editor.isReady.then(() => {
        if (ws.editor === editor) return editor.readOnly.set(!ws.access.canEdit(ws.currentId));
      }).catch(showError);
      ws.frame.element.toggleAttribute('data-desktop-read-only', !editable);
      ws.assistant.refreshPageActions();
    }
    return value;
  };
  /**
   * Étiquette chaque page racine avec sa section. La section est dérivée de
   * l'état de partage, jamais rangée dans la page : inviter quelqu'un fait
   * basculer la page tout seul, au prochain index reçu.
   */
  const withSections = (pages: DesktopPage[]): DesktopPage[] => {
    const tagged = pages.filter((page) => !page.databaseRowBody || !page.parentId).map((page) => ({ ...page, updatedAt: Math.max(page.updatedAt ?? 0, edits.at(page.id)), favorite: favorites.has(page.id) }));
    if (ref.kind !== 'remote') return tagged.map(page=>page.parentId ? page : {...page,section:'Privé'});
    if (!ws.index?.access) return tagged.map((page) => ({ ...page, section: page.parentId ? undefined : 'workspace' }));
    const roots = tagged.filter((page) => !page.parentId);
    const labelled = new Map(groupPagesBySection(roots, ws.index.access)
      .flatMap((group) => group.pages.map((page) => [page.id, sectionNames[group.section]] as const)));
    return tagged.map((page) => labelled.has(page.id) ? { ...page, section: labelled.get(page.id) } : page);
  };
  const readOnly = (pageId: string): boolean => !ws.access.canEdit(pageId);
  const canCreateUnder = (parentId: string | null): boolean =>
    parentId ? ws.access.canEdit(parentId) : !ws.access.readOnlyWorkspace;
  // The add-cover button is re-appended whenever the core rebuilds the icon row, and
  // WebKit keeps `:hover` latched on a node moved under the cursor. See trackPageHeaderHover.
  trackPageHeaderHover(document);
  const pageListeners = new Map<string, Set<() => void>>();
  const status = document.createElement('div');
  status.setAttribute('data-desktop-status', '');
  status.setAttribute('role', 'status');
  status.textContent = shellText("Ouverture des pages…");

  let closeTrash: (() => void) | undefined;
  const pageFromUrl = (): string | null => {
    const url = new URL(location.href);
    return libraryView(url) ? libraryPageId(url) : url.searchParams.get('page');
  };
  const navigate = (id: string, replace = false, view: PageView = 'document'): void => {
    const from = pageFromUrl();
    const url = pageUrlForView(new URL(location.href), id, view);
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    onRoute();
    // Notion ouvre une autre page à son début. Seul un vrai changement de page
    // remonte : corriger l'URL de la page courante laisse le lecteur où il est,
    // et la position par onglet, restaurée par shell.ts, n'est pas concernée.
    if (from !== id) window.scrollTo(0, 0);
  };
  const renderDocumentStatus = (): void => {
    if (ref.kind !== 'remote' || !ws.currentId || ws.manifestFailed) return;
    const notice = documentSyncStatus(ws.documentStatus, ws.pendingManifests > 0);
    if (status.textContent !== notice.message) status.textContent = notice.message;
    status.setAttribute('data-sync-state', notice.state);
    status.toggleAttribute('data-error', notice.state === 'error' || notice.state === 'denied');
  };
  const saveManifest = (): void => {
    if (!ws.index) return;
    // A title/cover callback can fire during a move. Snapshot its parent after
    // the queued move settles, so this write cannot undo a successful move.
    const snapshot = ws.movingPage ? undefined : JSON.stringify(ws.index);
    ws.pendingManifests++;
    renderDocumentStatus();
    ws.saveOrder = ws.saveOrder.catch(() => undefined).then(async () => {
      await repository.saveIndex(JSON.parse(snapshot ?? JSON.stringify(ws.index)) as WorkspaceIndex);
      ws.manifestFailed = false;
      ws.manifestError = undefined;
    }).catch((error: unknown) => {
      ws.manifestFailed = true;
      ws.manifestError = error;
      showError(error);
      throw error;
    }).finally(() => {
      ws.pendingManifests--;
      renderDocumentStatus();
    });
    void ws.saveOrder.catch(() => undefined);
  };
  const refreshRemoteManifest = async (signal?: AbortSignal): Promise<void> => {
    if (ref.kind !== 'remote' || !ws.index || ws.pendingManifests > 0 || ws.manifestFailed || ws.refreshingManifest || ws.metadataAction) return;
    ws.refreshingManifest = true;
    const original = ws.index;
    try {
      const updated = await repository.refreshIndex(() => !signal?.aborted && ws.pendingManifests === 0 && !ws.manifestFailed && !ws.metadataAction && ws.index === original, signal);
      if (!updated) return;
      const previousPage = calendar || currentLibrary() ? original.activeId : ws.currentId;
      if (updated.pages.some(page => page.id === previousPage)) updated.activeId = previousPage;
      // Retain the live page object: title/cover callbacks close over it.
      const live = original.pages.find((page) => page.id === ws.currentId);
      const remotePage = updated.pages.find((page) => page.id === ws.currentId);
      if (live && remotePage) {
        adoptRemoteFields(live, remotePage);
        updated.pages = updated.pages.map((page) => page.id === ws.currentId ? live : page);
      }
      adoptIndex(updated);
      ws.frame.setPages(withSections(ws.index.pages), currentLibrary() ? '' : ws.index.activeId);
      ws.pageToolbar?.setBreadcrumbs(breadcrumbs(ws.currentId));
      for (const id of new Set([...original.pages.map((page) => page.id), ...ws.index.pages.map((page) => page.id)])) notifyPage(id);
      ws.refreshPagePresentation?.();
      if (library) {
        const peek = libraryPageId(new URL(location.href));
        if (peek && !ws.index.pages.some(page => page.id === peek)) {
          ++ws.generation;
          clearDocument();
          ws.pageCanvas.replaceChildren();
          routeLibraryPage(null, true);
        } else library.refresh();
      } else if (!currentLibrary() && !ws.index.pages.some((page) => page.id === ws.currentId)) onRoute();
    } catch (error) { if (!signal?.aborted && !ws.manifestFailed) showError(error); }
    finally { ws.refreshingManifest = false; }
  };
  const refreshDateTitles = (): void => {
    if (!ws.index || ref.kind === 'remote') return;
    const dateState = { changed: false };
    for (const page of ws.index.pages) {
      if (!page.titleDate) continue;
      const display = titleDateLabel(page.titleDate, new Date(), page.titleDateDisplay);
      const label = display === null ? null : `@${display}${page.titleDateSuffix ?? ''}`;
      if (label === null || label === page.title) continue;
      page.title = label;
      dateState.changed = true;
      notifyPage(page.id);
    }
    if (!dateState.changed) return;
    ws.frame.setPages(withSections(ws.index.pages), currentLibrary() ? '' : ws.index.activeId);
    library?.refresh();
    ws.pageToolbar?.setBreadcrumbs(breadcrumbs(ws.currentId));
    const active = ws.index.pages.find((page) => page.id === ws.currentId);
    if (active?.titleDate && ws.editor) {
      ws.editor.title.set(active.title, { record: false });
      ws.titleDateMention?.refresh();
      document.title = active.title;
    }
    saveManifest();
  };
  const scheduleDateRefresh = (): void => {
    if (ws.dateTimer !== null) window.clearTimeout(ws.dateTimer);
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    ws.dateTimer = window.setTimeout(() => {
      ws.dateTimer = null;
      refreshDateTitles();
      scheduleDateRefresh();
    }, midnight.getTime() - now.getTime() + 50);
  };
  const notifyPage = (id: string): void => { pageListeners.get(id)?.forEach((listener) => listener()); };
  const breadcrumbMenuHeading = (parentId: string | null | undefined, byId: Map<string, ShellPage>): string => {
    if (parentId) return byId.get(parentId)?.title ?? 'Pages';
    return ref.kind === 'remote' ? ref.name : 'Pages locales';
  };
  const breadcrumbs = (pageId: string): PageBreadcrumbItem[] => {
    if (!ws.index) return [];
    const pages = ws.index.pages;
    const byId = new Map(pages.map((page) => [page.id, page]));
    const seen = new Set<string>();
    const trail: ShellPage[] = [];
    const trailState = { page: byId.get(pageId) };

    while (trailState.page && !seen.has(trailState.page.id)) {
      trail.unshift(trailState.page);
      seen.add(trailState.page.id);
      trailState.page = trailState.page.parentId ? byId.get(trailState.page.parentId) : undefined;
    }
    const choicesFor = (parentId: string | null, selectedId: string, visited: Set<string> = new Set()): PageBreadcrumbChoice[] =>
      pages.filter((candidate) => candidate.parentId === parentId && !visited.has(candidate.id)).map((candidate) => {
        const children = choicesFor(candidate.id, pageId, new Set([...visited, candidate.id]));

        return {
          id: candidate.id, title: candidate.title, icon: candidate.icon,
          current: candidate.id === selectedId || candidate.id === pageId,
          ...(children.length ? { children } : {}),
          onOpen: () => navigate(candidate.id),
        };
      });
    return trail.map((item, position) => ({
      id: item.id, title: item.title, icon: item.icon,
      ...(position < trail.length - 1 ? { onOpen: () => navigate(item.id) } : {}),
      menuHeading: breadcrumbMenuHeading(item.parentId, byId),
      menu: choicesFor(item.parentId, item.id),
    }));
  };
  const showError = (error: unknown): void => {
    // Un retrait d'accès ferme la session en moins de cinq secondes côté
    // serveur. Le présenter comme une panne d'enregistrement laisserait croire
    // à un incident, et pousserait à réessayer pour rien.
    const refusal = error instanceof RepositoryHttpError && [401, 403, 404].includes(error.status)
      ? 'Accès refusé. Vérifiez votre connexion au compte et vos droits sur cet espace.'
      : describeAccessLoss(error);
    const conflict = error instanceof WorkspaceConflictError || error instanceof PageMoveConflict;
    status.textContent = refusal ?? (error instanceof PageMoveConflict ? error.message : conflict
      ? shellText("Conflit sur les pages de l’espace. Copiez vos changements avant de recharger pour comparer les versions.")
      : shellText("Enregistrement impossible : {v0}", {v0: String(error)}));
    status.setAttribute('data-error', '');
    status.setAttribute('data-sync-state', refusal ? 'denied' : conflict ? 'conflict' : 'error');
    if (ref.kind === 'remote' && ws.manifestFailed && ws.manifestError === error &&
        (error instanceof TypeError || (error instanceof RepositoryHttpError && (error.status >= 500 || error.status === 429)))) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = shellText("Réessayer");
      retry.addEventListener('click', () => {
        retry.disabled = true;
        saveManifest();
      });
      status.append(' ', retry);
    }
  };
  const iconValue = (icon: ReturnType<Blok['title']['icon']['get']>): string | undefined => {
    if (icon?.type === 'emoji') return icon.value;
    if (icon?.type === 'image') return icon.url;
    return undefined;
  };
  const syncPageIcon = (
    page: ShellPage,
    icon: ReturnType<Blok['title']['icon']['get']>,
    persist = true,
    adoptOnly = false,
  ): void => {
    if (!ws.index) return;
    const target = page;
    const next = nextPageIcon(target.icon, iconValue(icon), { adoptOnly });
    if (target.icon !== next) {
      target.icon = next;
      if (persist && !adoptOnly) edits.mark(target.id);
      ws.frame.setPages(withSections(ws.index.pages), currentLibrary() ? '' : ws.index.activeId);
      ws.pageToolbar?.setBreadcrumbs(breadcrumbs(ws.currentId));
      if (persist) saveManifest();
      notifyPage(target.id);
    }
    onPageIcon(target.id, next ?? '');
  };
  const pageConfig: PageConfig = {
    createFromMention: true,
    todayMention: { label: shellText("Aujourd’hui"), heading: shellText("Date"), locale: shellLocale() },
    databasePages: true,
    search: async (query) => {
      if (!ws.index) return [];
      const needle = query.trim().toLocaleLowerCase();
      return ws.index.pages.filter((page) => page.title.toLocaleLowerCase().includes(needle)).slice(0, 40)
        .map((page) => ({ pageId: page.id, title: page.title,
          ...(page.icon ? { icon: pageIcon(page.icon) } : {}) }));
    },
    resolve: (id) => {
      const page = ws.index?.pages.find((item) => item.id === id);
      return page ? { title: page.title, ...(page.icon ? { icon: pageIcon(page.icon) } : {}) } : null;
    },
    subscribe: (id, listener) => {
      const listeners = pageListeners.get(id) ?? new Set<() => void>();
      listeners.add(listener);
      pageListeners.set(id, listeners);
      return () => { listeners.delete(listener); if (listeners.size === 0) pageListeners.delete(id); };
    },
    href: (id) => `?page=${encodeURIComponent(id)}`,
    pageIdFromHref: (href) => {
      const url = new URL(href);
      if (ref.kind === 'remote' && url.origin === ref.server) return pageIdForWorkspaceLink(ref, href);
      const link = webPageLink(url);
      return link?.origin === location.origin && (!link.local || ref.kind === 'local') && (!link.workspace || link.workspace === ref.id) ? link.id : null;
    },
    open: (id) => { if (ws.index?.pages.some((page) => page.id === id)) navigate(id); },
    create: async ({ pageId, title, parentId, document: initialDocument }) => {
      if (!ws.index || !canCreateUnder(parentId ?? ws.currentId ?? null)) throw new Error('Espace indisponible ou en lecture seule');
      if (ws.index.pages.some((page) => page.id === pageId)) throw new Error('Cette page existe déjà');
      const page: DesktopPage = { id: pageId, title: title?.trim() || shellText("Nouvelle page"), parentId: parentId ?? ws.currentId };
      if (initialDocument && ref.kind === 'local') await repository.writePage(pageId, JSON.stringify(initialDocument));
      ws.index.pages.push(page);
      ws.frame.setPages(withSections(ws.index.pages), currentLibrary() ? '' : ws.index.activeId);
      saveManifest();
      await ws.saveOrder;
      if (initialDocument && ref.kind === 'remote') await repository.seedPage(pageId, initialDocument);
      notifyPage(pageId);
    },
  };
  const select = async (id: string): Promise<void> => {
    if (!ws.index) return;
    refreshDateTitles();
    const request = ++ws.selection;
    if (ws.currentId !== id) {
      editAssistant?.cancel();
      ws.assistant.refreshPageActions();
    }
    if (ws.currentId !== id && ref.kind === 'remote') {
      if (ws.editor) { await ws.editor.isReady; await ws.editor.saver.flush(); }
      if (ws.selection !== request) return;
      if (ws.index.access && !ws.index.access[id]) {
        // Creating a page acknowledges the index revision before its access
        // entry reaches this window. Get the server's decision before mounting.
        await ws.saveOrder;
        const index = ws.index;
        const access = await repository.readPageAccess(id);
        if (ws.selection !== request) return;
        if (ws.index === index) {
          index.access = { ...index.access, [id]: access };
          ws.access = pageAccess(ref, index.access);
        }
      }
    }
    if (ws.selection !== request) return;
    const page = ws.index.pages.find((item) => item.id === id);
    if (!page) return;
    const selectedPage = page;
    ws.index.activeId = id;
    if (ref.kind === 'local') saveManifest();
    ws.frame.setPages(withSections(ws.index.pages), id);
    if (!currentLibrary()) onPageIcon(id, page.icon ?? '');
    if (ws.currentId === id) {
      board?.setView(pageView(new URL(location.href)));
      // A new tab can display the already mounted editor without reloading its document.
      document.title = currentLibrary() ? brandedTitle('Bibliothèque') : page.title;
      ws.pageToolbar?.setBreadcrumbs(breadcrumbs(id));
      return;
    }
    ws.currentId = id;
    recentPages.visit(id);
    ws.frame.element.toggleAttribute('data-desktop-read-only', readOnly(id));
    const turn = ++ws.generation;
    ws.coverRowObserver?.disconnect();
    ws.coverRowObserver = null;
    board?.destroy(); board = undefined;
    ws.pageToolbar?.destroy();
    ws.floatingToc?.destroy();
    ws.floatingToc = null;
    ws.titleDateMention?.destroy();
    ws.titleDateMention = null;
    ws.editor?.destroy();
    ws.editor = null;
    ws.documentStatus = undefined;
    if (!ws.manifestFailed) {
      status.textContent = shellText("Ouverture de la page…");
      status.removeAttribute('data-sync-state');
      status.removeAttribute('data-error');
    }
    const article = document.createElement('article');
    article.setAttribute('data-desktop-document', '');
    const applyFullWidth = (): void => {
      const enabled = page.fullWidth === true;
      ws.pageCanvas.toggleAttribute('data-full-width', enabled);
      article.toggleAttribute('data-full-width', enabled);
      ws.editor?.width.set(enabled ? 'full' : 'narrow');
    };
    const viewControls = document.createElement('div');
    const toolbar = createPageToolbar(breadcrumbs(id), page.fullWidth === true, (enabled) => {
      if (readOnly(id)) return;
      page.fullWidth = enabled;
      applyFullWidth();
      saveManifest();
    }, '__TAURI_INTERNALS__' in window ? undefined : () => {
      ws.frame.toggleSidebar();
      onLayout(sidebar.getBoundingClientRect().width);
    }, ref.kind === 'remote' ? (anchor) => openPageSharing(ref, id, page.title, anchor, refreshRemoteManifest) : undefined, {
      viewControls,
      workspaceName: ref.name,
      workspacePages: () => {
        const pages = withSections(ws.index?.pages ?? []);
        const choice = (page: DesktopPage): PageBreadcrumbChoice => ({
          id: page.id, title: page.title, icon: page.icon, current: page.id === ws.currentId,
          onOpen: () => navigate(page.id),
          children: pages.filter((child) => child.parentId === page.id).map(choice),
        });
        return pages.filter((page) => !page.parentId && (ref.kind === 'local' || page.section === 'workspace')).map(choice);
      },
      pageUrl: pageId => workspacePageLink(ref, pageId, pageView(new URL(location.href))),
      favorite: favorites.has(id),
      onFavorite: (value) => {
        favorites.set(id, value);
        if (ws.index) ws.frame.setPages(withSections(ws.index.pages), ws.currentId);
      },
      readOnly: readOnly(id),
      onHistory: ref.kind === 'remote' ? () => openPageHistory({
        base:ref.server+'/api/blok/sync/'+encodeURIComponent(id)+'/history', title:page.title,
        ticket:()=>repository.ticket(id), editable:()=>ws.currentId===id && !readOnly(id),
        flush:async()=>{
          const editor = ws.editor;
          if (!editor) return;
          await editor.isReady;
          if (ws.editor === editor && ws.currentId === id) await editor.saver.flush();
        },
      }) : undefined,
      onRename: () => {
        const title = holder.querySelector<HTMLElement>('[data-blok-title] h1, h1[contenteditable="true"]');
        title?.focus();
        if (title) { const range = document.createRange(); range.selectNodeContents(title); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      },
      onDuplicate: () => { void action({ id, type: 'duplicate' }).catch(showError); },
      onDelete: () => { void action({ id, type: 'delete' }).catch(showError); },
    });
    ws.pageToolbar = toolbar;
    applyFullWidth();
    const holder = document.createElement('div');
    article.append(holder);
    const cover = { node: null as HTMLElement | null, readOnly: false, rendered: undefined as PageCover | undefined, position: undefined as number | undefined, button: null as HTMLButtonElement | null };
    function changeCover(cover: PageCover | undefined): void {
      if (readOnly(id)) return;
      selectedPage.cover = cover;
      if (cover === undefined) selectedPage.coverPosition = undefined;
      if (ws.generation === turn) renderCover();
      saveManifest();
    }
    const attachCoverAction = (): void => {
      if (readOnly(id)) return;
      if (isPageCover(page.cover)) return;
      const row = holder.querySelector<HTMLElement>('[data-blok-page-icon-row]');
      if (!row) return;
      cover.button ??= createAddCoverButton(changeCover);
      if (cover.button.parentElement !== row) row.append(cover.button);
      if (ws.coverRowObserver === null) {
        ws.coverRowObserver = new MutationObserver(() => {
          if (ws.generation === turn) attachCoverAction();
        });
        ws.coverRowObserver.observe(row, { childList: true });
      }
    };
    const renderCover = (): void => {
      article.toggleAttribute('data-has-cover', isPageCover(page.cover));
      if (isPageCover(page.cover)) {
        cover.button?.remove();
        const position = typeof page.coverPosition === 'number' && Number.isFinite(page.coverPosition)
          ? Math.max(0, Math.min(100, page.coverPosition)) : 50;
        // Background metadata refreshes must preserve the open picker and its focus.
        const locked = readOnly(id);
        if (cover.node && cover.rendered === page.cover && cover.position === position && cover.readOnly === locked) return;
        cover.readOnly = locked;
        cover.rendered = page.cover;
        cover.position = position;
        const next = createPageCover(page.cover, position, changeCover, (value) => {
          if (readOnly(id)) return;
          page.coverPosition = value;
          cover.position = value;
          saveManifest();
        }, { upload: repository.uploadImage, resolveUrl: repository.assetUrl, readOnly: locked });
        if (cover.node) cover.node.replaceWith(next);
        else ws.pageCanvas.insertBefore(next, article);
        cover.node = next;
      } else {
        cover.node?.remove();
        cover.node = null;
        attachCoverAction();
      }
    };
    ws.refreshPagePresentation = () => { applyFullWidth(); renderCover(); ws.titleDateMention?.refresh(); };
    ws.pageCanvas.replaceChildren(toolbar.element, article);
    let boardEditorReady = false;
    board = mountPageWhiteboard({
      assets: {origin: ref.kind === 'remote' ? ref.server : undefined, resolve: repository.assetUrl},
      getEditor: () => boardEditorReady ? ws.editor : null,
      holder, controls: viewControls, initialView: pageView(new URL(location.href)),
      onViewChange: view => navigate(id, false, view),
    });
    renderCover();
    editAssistant = pageEditorAssistant(ai,
      () => ws.generation === turn && activeEditable(),
      () => localStorage.getItem(selectionKey(ref)));
    const instance = new Blok({
      holder,
      agent: ws.access.readOnlyWorkspace ? undefined : editAssistant.agent,
      readOnly: readOnly(id),
      tools: { ...desktopTools, database: {class: Database, config: {...(ref.kind === 'remote' && {people: {me: () => ref.accountId, list: repository.listPeople}}), customEmojis: () => emojis.list(), coverGallery: COVER_GALLERY, uploadCover: (file: globalThis.File) => readCoverFile(file).then(repository.uploadImage)}}, page: { class: Page, config: { ...pageConfig } } },
      theme: readAppearance(),
      i18n: {locale: shellLocale()},
      onChange: () => { if (ws.generation === turn) edits.mark(id); },
      pageTitle: {
        customEmojis: () => emojis.list(),
        placeholder: shellText("Nouvelle page"),
        onChange(title, change) {
          if (ws.generation !== turn || !ws.index) return;
          const next = title.trim() || 'Nouvelle page';
          if (page.titleDate && change.source === 'user') {
            const label = titleDateLabel(page.titleDate, new Date(), page.titleDateDisplay);
            const prefix = label === null ? '' : `@${label}`;
            const token = holder.querySelector('[data-desktop-title-date-token]');
            if (token && next.startsWith(prefix)) page.titleDateSuffix = next.slice(prefix.length);
            else {
              page.titleDate = undefined;
              page.titleDateDisplay = undefined;
              page.titleDateSuffix = undefined;
            }
          }
          if (page.title !== next && change.source === 'user') edits.mark(id);
          page.title = next;
          holder.querySelector<HTMLElement>('[data-blok-page-title]')?.toggleAttribute('data-desktop-title-date', !!page.titleDate);
          toolbar.setBreadcrumbs(breadcrumbs(id));
          notifyPage(id);
          if (!currentLibrary()) document.title = next;
          ws.frame.setPages(withSections(ws.index.pages), id);
          if (ref.kind === 'local' || change.source !== 'remote') saveManifest();
        },
        onIconChange(icon, change) {
          if (ws.generation !== turn || !ws.index) return;
          syncPageIcon(page, icon, ref.kind === 'local' || change.source !== 'remote');
        },
      },
      documentId: ref.kind === 'local' && ref.id === 'default' ? id : `${workspaceKey(ref)}:${id}`,
      ...(ref.kind === 'remote' ? {
        server: `${ref.server}/api/blok`,
        ticket: ({ doc }: { doc?: string; forceRefresh?: boolean }) => repository.ticket(doc ?? id),
        user: { id: ref.accountId },
        collaboration: { doc: id, user: { name: ref.userName ?? ref.accountId }, offline: false },
      } : { persistence: {
        async load() {
          const raw = await repository.readPage(id);
          return raw ? JSON.parse(raw) as OutputData : null;
        },
        async save(data) {
          await repository.writePage(id, JSON.stringify(data));
        },
        onError: showError,
      } }),
    });
    ws.editor = instance;
    ws.assistant.refreshPageActions();
    instance.width.set(page.fullWidth === true ? 'full' : 'narrow');
    void instance.isReady.then(() => {
      if (ws.generation !== turn) return;
      boardEditorReady = true;
      board?.refresh();
      instance.on('collaboration:status', (event:CollaborationStatusChangedPayload) => {
        if (ws.generation !== turn || ref.kind !== 'remote') return;
        toolbar.setPeers(event.status === 'connected' ? event.participants.filter(p=>p.present && !p.self)
          .map(p=>p.user.name || p.user.label || 'Anonyme') : []);
        ws.documentStatus = event;
        renderDocumentStatus();
      });

      const redactor = holder.querySelector<HTMLElement>('[data-blok-redactor]');
      if (redactor) ws.floatingToc = createFloatingToc(ws.pageCanvas, redactor);
      attachCoverAction();
      if (ref.kind === 'local' && (!instance.title.get() || page.titleDate)) instance.title.set(page.title, { record: false });
      const title = holder.querySelector<HTMLElement>('[data-blok-page-title]');
      if (title) {
        const updateDateTitle = (): void => {
          const label = page.titleDate ? titleDateLabel(page.titleDate, new Date(), page.titleDateDisplay) : null;
          const next = label === null ? 'Nouvelle page' : `@${label}${page.titleDateSuffix ?? ''}`;
          page.title = next;
          instance.title.set(next);
          if (page.titleDate) title.setAttribute('data-desktop-title-date', page.titleDate);
          else title.removeAttribute('data-desktop-title-date');
          saveManifest();
        };
        ws.titleDateMention = bindTitleDateMention(title, {
          getDate: () => page.titleDate,
          getDisplay: () => page.titleDateDisplay ?? {},
          setDate: (value) => {
            if (!page.titleDate || value === null) page.titleDateSuffix = undefined;
            page.titleDate = value ?? undefined;
            if (value === null) page.titleDateDisplay = undefined;
            updateDateTitle();
          },
          setDisplay: (change: DateDisplayChange) => {
            const display = { ...page.titleDateDisplay };
            if ('dateFormat' in change) display.dateFormat = change.dateFormat;
            if ('timeFormat' in change) display.timeFormat = change.timeFormat;
            if ('timeZone' in change) {
              if (change.timeZone === null) delete display.timeZone;
              else display.timeZone = change.timeZone;
            }
            page.titleDateDisplay = display;
            updateDateTitle();
          },
          i18n: instance.i18n,
        });
      }
      // Load-time read only: on a remote page the document — and its icon —
      // lands after the editor is ready, so this must never clear (flash).
      syncPageIcon(page, instance.title.icon.get(), ref.kind === 'local', true);
      toolbar.setBreadcrumbs(breadcrumbs(id));
      document.title = currentLibrary() ? brandedTitle('Bibliothèque') : page.title;
      if (ref.kind === 'local' && !ws.manifestFailed) status.textContent = '';
    }).catch((error: unknown) => {
      if (ws.generation === turn) showError(error);
    });
  };

  const duplicatePage = async (page: DesktopPage): Promise<'navigated' | 'pending'> => {
    if (ref.kind === 'remote') {
      const copy = {id: crypto.randomUUID(), title: shellText("{v0} (copie)", {v0: page.title}), parentId: page.parentId};
      if (ws.editor) { await ws.editor.isReady; await ws.editor.saver.flush(); }
      await ws.saveOrder;
      await repository.duplicatePage(page.id, copy);
      const refreshed = adoptIndex(await repository.loadIndex());
      ws.frame.setPages(withSections(refreshed.pages), refreshed.activeId);
      navigate(copy.id);
      return 'navigated';
    }
    if (!ws.index) return 'navigated';
    const copy: DesktopPage = { ...page, id: crypto.randomUUID(), title: shellText("{v0} (copie)", {v0: page.title}), titleDate: undefined, titleDateDisplay: undefined, titleDateSuffix: undefined };
    edits.mark(copy.id);
    ws.index.pages.push(copy);
    saveManifest();
    void repository.readPage(page.id).then(async (raw) => {
      if (raw) {
        const data = JSON.parse(raw) as OutputData;
        await repository.writePage(copy.id, JSON.stringify({ ...data, id: copy.id, title: copy.title }));
      }
      navigate(copy.id);
    }).catch(showError);
    return 'pending';
  };

  const deletePage = (page: DesktopPage): void => {
    if (!ws.index || ws.index.pages.length === 1) return;
    const removed = new Set([page.id]);
    const removeState = { previous: -1 };
    while (removeState.previous !== removed.size) {
      removeState.previous = removed.size;
      ws.index.pages.forEach((item) => { if (item.parentId && removed.has(item.parentId)) removed.add(item.id); });
    }
    if (removed.size === ws.index.pages.length) return;
    ws.index.trash = [...(ws.index.trash ?? []), ...ws.index.pages.filter((item) => removed.has(item.id))];
    ws.index.pages = ws.index.pages.filter((item) => !removed.has(item.id));
    removed.forEach(notifyPage);
    const fallback = ws.index.pages[0];
    if (removed.has(ws.currentId) && fallback) navigate(fallback.id, true);
  };

  let pendingSearch: { recentIds?: string[] } | undefined;

  function showPageSearch(recentIds?: string[]): void {
    if (!ws.index) {
      pendingSearch = { recentIds };
      return;
    }
    ws.closeSearch?.();
    const pages = () => ws.index?.pages ?? [];
    ws.closeSearch = openPageSearch({
      workspaceName: ref.name, pages, onOpen: (id, view) => navigate(id, false, view), pageUrl,
      recentIds: recentIds ?? recentPages.ids, recentOnly: recentIds !== undefined,
      visitedAt: recentPages.visitedAt,
      pageLinkFromUrl: value => resolveWorkspacePageLink(ref, value),
      onOpenTab: (id, view) => {
        const page = pages().find(item => item.id === id);
        if (page) openPageTab(page, view);
      },
      chats: () => ws.assistant.searchableChats(),
      onOpenChat: id => ws.assistant.openChat(id),
      ...repository.pageSearch(pages),
    });
  }

  const openPageTab = (page: DesktopPage, view: PageView = 'document'): void => {
    if ('__TAURI_INTERNALS__' in window) {
      window.dispatchEvent(new CustomEvent('blok:desktop-new-tab', {
        detail: {id: page.id, title: page.title, icon: page.icon, view},
      }));
      return;
    }
    const url = pageUrlForView(new URL(location.href), page.id, view);
    window.open(url.href, '_blank', 'noopener,noreferrer');
  };

  const renamePage = (page: DesktopPage, title: string): void => {
    const target = page;
    edits.mark(page.id);
    target.title = title;
    target.titleDate = undefined;
    target.titleDateDisplay = undefined;
    target.titleDateSuffix = undefined;
    notifyPage(target.id);
    if (ws.currentId === target.id) ws.editor?.title.set(title);
    else ws.pageToolbar?.setBreadcrumbs(breadcrumbs(ws.currentId));
  };

  const flushRemoteBeforeAction = async (command: SidebarAction): Promise<void> => {
    if (ref.kind !== 'remote' || !ws.editor || command.type === 'open-tab') return;
    await ws.editor.isReady;
    await ws.editor.saver.flush();
    await ws.saveOrder;
  };

  const movePage = async (id: string, originalParent: string | null, parentId: string | null): Promise<void> => {
    if (ws.metadataAction || !ws.index) return;
    const wasInert = ws.frame.element.inert;
    ws.frame.element.inert = true;
    ws.metadataAction = true;
    try {
      await flushRemoteBeforeAction({ type: 'move', id });
      await ws.saveOrder;
      const page = ws.index.pages.find((item) => item.id === id);
      if (!page || page.parentId !== originalParent) throw new PageMoveConflict();
      ws.movingPage = true;
      ws.pendingManifests++;
      renderDocumentStatus();
      try {
        const commit = repository.movePage(ws.index, id, parentId).then(() => { page.parentId = parentId; });
        ws.saveOrder = commit.catch(() => undefined);
        await commit;
        ws.frame.setPages(withSections(ws.index.pages), currentLibrary() ? '' : ws.index.activeId);
        ws.pageToolbar?.setBreadcrumbs(breadcrumbs(ws.currentId));
        notifyPage(id);
      } finally {
        ws.movingPage = false;
        ws.pendingManifests--;
        renderDocumentStatus();
      }
    } finally {
      ws.frame.element.inert = wasInert;
      ws.metadataAction = false;
    }
    await refreshRemoteManifest();
  };

  const action = async (command: SidebarAction): Promise<void> => {
    if (command.type !== 'open-tab' && readOnly(command.id)) return;
    if (command.type === 'move') {
      const page = ws.index?.pages.find((item) => item.id === command.id);
      if (!page) return;
      const originalParent = page.parentId;
      ws.closeSearch?.();
      ws.closeSearch = openMovePicker({
        workspaceName: ref.name, sourceTitle: page.title, remote: ref.kind === 'remote',
        pages: () => ws.index?.pages ?? [],
        destinations: () => moveDestinations(ws.index?.pages ?? [], page.id, ws.access),
        onChoose: (parentId) => { void movePage(page.id, originalParent, parentId).catch(showError); },
      });
      return;
    }
    const wasInert = ws.frame.element.inert;
    if (ref.kind === 'remote') { ws.frame.element.inert = true; ws.metadataAction = true; }
    try {
      await flushRemoteBeforeAction(command);
      if (!ws.index) return;
      const page = ws.index.pages.find((item) => item.id === command.id);
      if (!page) return;
      if (command.type === 'rename') renamePage(page, command.title);
      else if (command.type === 'duplicate') { await duplicatePage(page); return; }
      else if (command.type === 'delete') deletePage(page);
      else if (command.type === 'open-tab') { openPageTab(page); return; }
      else return;
      ws.frame.setPages(withSections(ws.index.pages), currentLibrary() ? '' : ws.index.activeId);
      saveManifest();
    } finally { ws.frame.element.inert = wasInert; ws.metadataAction = false; }
  };

  function openLibrary(view: LibraryView = 'recents'): void {
    const next = libraryUrl(new URL(location.href), view);
    if (location.href !== next.href) history.pushState(null, '', next);
    onRoute();
  }

  function openHome(): void {
    ws.assistant.close();
    if (!currentLibrary() && !isCalendarRoute()) return;
    if (ws.index?.activeId) navigate(ws.index.activeId);
    else {
      history.pushState(null, '', editorUrl(new URL(location.href)));
      onRoute();
    }
  }

  function teamPageNavigation(): TeamPageNavigation {
    return {
      pages: () => ws.index?.pages ?? [],
      canEdit: (id) => ws.access.canEdit(id),
      open: async (id, signal) => {
        const visible = () => ws.index?.pages.some((page) => page.id === id);
        if (!visible()) { await ws.saveOrder; signal.throwIfAborted(); await refreshRemoteManifest(signal); }
        signal.throwIfAborted();
        if (!visible()) throw new CloudApiError(404, 'Page indisponible');
        navigate(id);
      },
    };
  }
  function manageTeamspaces(initialView?: 'create'): void {
    if (ref.kind !== 'remote') return;
    ws.footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', {detail: initialView === 'create' ? 'teams-create' : 'teams'}));
  }

  const teamspacePermission = { allowed: false, pending: undefined as AbortController | undefined };
  const createTeamspace = () => manageTeamspaces('create');
  async function refreshTeamspacePermission() {
    if (!ws.frame.element.isConnected) return;
    teamspacePermission.pending?.abort();
    const request = new AbortController();
    teamspacePermission.pending = request;
    const allowed = await repository.canCreateTeamspace(request.signal).catch(() => false);
    if (request.signal.aborted || !ws.frame.element.isConnected || allowed === teamspacePermission.allowed) return;
    teamspacePermission.allowed = allowed;
    if (ws.index) ws.frame.setPages(withSections(ws.index.pages), currentLibrary() ? '' : ws.index.activeId);
    library?.refresh();
  }

  function openTrash(): void {
    if (ref.kind !== 'remote') return;
    closeTrash?.();
    closeTrash = openRemoteTrash(ref, () => ws.saveOrder, refreshRemoteManifest);
  }

  const openWorkspaceSettings = (panel: 'invites' | 'general' | 'backups') =>
    ws.footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', {detail: panel}));
  const teamspaceActions = [
    ...(ref.kind === 'remote' && ref.embedded && ref.device && ref.role === 'admin'
      ? [{name:'backup', title:shellText("Sauvegarde de l’espace"), run:() => openWorkspaceSettings('backups')}] : []),
    ...(ref.kind === 'remote' && ref.role === 'admin'
      ? [{name: 'invite', title: shellText("Inviter des membres"), run: () => openWorkspaceSettings('invites')}] : []),
    ...(ref.kind === 'remote' ? [
      {name: 'teams', title: shellText("Gérer les espaces d’équipe"), run: () => manageTeamspaces()},
      {name: 'trash', title: shellText("Corbeille"), run: openTrash},
    ] : []),
    {name: 'settings', title: shellText("Paramètres de l’espace"), run: () => openWorkspaceSettings('general')},
  ];
  const desktopDownloadUrl: unknown = import.meta.env.VITE_BLOK_DESKTOP_DOWNLOAD_URL;
  const createFrame = import.meta.env.VITE_SIDEBAR_TSX === '0' ? createPageFrame : createReactPageFrame;
  ws.frame = createFrame({
    loadingPages: true,
    teamspace: ref.kind === 'remote' ? { name: ref.name } : undefined,
    pages: [], activeId: '', collapsedByDefault: true, preferenceKey: workspaceKey(ref),
    recentIds: recentPages.ids,
    onRecentsChange: recentPages.save,
    onOpen: (id) => navigate(id),
    onCreate: (parentId) => chooseNewPage(parentId),
    calendarHref: '__TAURI_INTERNALS__' in window ? undefined : calendarUrl(new URL(location.href)).href,
    onOpenLibrarySection: openLibrary,
    onDownloadDesktop: !('__TAURI_INTERNALS__' in window) && typeof desktopDownloadUrl === 'string' && desktopDownloadUrl.trim()
      ? () => window.location.assign(desktopDownloadUrl) : undefined,
    get canCreateTeamspace() { return teamspacePermission.allowed; },
    onCreateTeamspace: createTeamspace,
    onConnectCalendar: () => ws.footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', {detail: ref.kind === 'remote' ? 'calendar' : 'import'})),
    upcomingEvents: async (signal) => {
      const [{upcomingCalendarEvents}, {createCalendarStore}] = await Promise.all([import('./calendar-sources'), import('./calendar-store')]);
      signal.throwIfAborted();
      return upcomingCalendarEvents(createCalendarStore(ref), signal);
    },
    onCalendar: () => ws.footer.dispatchEvent(new Event('blok:desktop-open-agenda')),
    onCreatePrivate: () => chooseNewPage(null, ref.kind === 'remote'),
    onSearch: showPageSearch,
    onHome: openHome,
    onChat: () => ws.assistant.open(),
    onNewChat: () => ws.assistant.newChat(),
    onLibrary: () => openLibrary(),
    onInviteMembers: ref.kind === 'remote' && !ref.embedded && ref.role === 'admin'
      ? () => ws.footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', {detail: 'invites'})) : undefined,
    onTeamspaces: ref.kind === 'remote' ? () => openLibrary('teamspaces') : undefined,
    teamspaceActions,
    onTeamspaceMenu: (anchor) => {
      const menuState = { action: undefined as (() => void) | undefined, settled: false };
      const menu = new PopoverDesktop({ trigger: anchor, autoFocusFirstItem: true,
        items: teamspaceActions.map(({name, title, run}) => ({
          name, title, closeOnActivate: true, onActivate: () => { menuState.action = run; },
        })),
      });
      anchor.setAttribute('aria-expanded', 'true');
      menu.on('closed', () => {
        if (menuState.settled) return;
        menuState.settled = true;
        anchor.setAttribute('aria-expanded', 'false');
        // Release the menu's focus manager before handing focus to a modal.
        queueMicrotask(() => {
          menu.destroy();
          menuState.action?.();
        });
      });
      menu.show();
    },
    onAction: (command) => { void action(command).catch(showError); },
    pageUrl,
    availableActions: ['rename', 'move', 'duplicate', 'delete', 'open-tab'],
    canEdit: (id) => !readOnly(id),
    canCreate: canCreateUnder,
    onFavorite: (id, value) => {
      favorites.set(id, value);
      library?.refresh();
      if (ws.currentId === id) ws.pageToolbar?.setFavorite(value);
    },
  });
  ws.frame.element.append(status);
  ws.assistant = mountAgentAssistant({
    onOpenChange: open => ws.frame.setChatActive(open),
    workspaceSearch: ref.kind === 'remote' ? { find: repository.searchSources, open: navigate } : undefined,
    getPageText: () => ws.pageCanvas.querySelector('[data-desktop-document]')?.textContent?.slice(0, 100_000) ?? '',
    openSettings: () => ws.footer.dispatchEvent(new Event('blok:desktop-open-ai-settings')),
    editPage: {
      available: () => !!editAssistant?.agent && activeEditable(),
      open: () => { if (activeEditable()) ws.editor?.agent.openAssistant(); },
    },
    ...createWorkspaceAssistant(ref),
  });
  ws.pageCanvas = ws.assistant.editorSlot;
  const libraryHost = document.createElement('div');
  libraryHost.setAttribute('data-desktop-library-host', '');
  libraryHost.hidden = true;
  const libraryContent = document.createElement('div');
  libraryContent.setAttribute('data-library-content', '');
  libraryHost.append(libraryContent);
  ws.pageCanvas.before(libraryHost);
  ws.frame.canvas.append(ws.assistant.element);
  const calendarHost = document.createElement('section');
  calendarHost.setAttribute('data-desktop-calendar-app', '');
  calendarHost.hidden = true;
  libraryHost.before(calendarHost);
  const sidebar = ws.frame.element.querySelector('[data-blok-sidebar]') as HTMLElement;
  const panel = ws.assistant.element.querySelector<HTMLElement>('[data-blok-agent-panel]');
  const assistantButton = createAssistantButton(() => {
    if (!panel || panel.hidden) ws.assistant.open();
    else ws.assistant.close();
  });
  ws.frame.canvas.append(assistantButton);
  if (panel) bindAssistantButton(assistantButton, panel);
  ws.footer = createDesktopFooter((mode) => ws.editor?.theme.set(mode), ref, ws.frame.headerActions, {
    flushForBackup: flushDocument,
    async onLanguageChange(locale) {
      await flushDocument();
      rememberShellLanguage(locale);
      sessionStorage.setItem('blok:desktop:pending-settings', 'preferences');
      location.reload();
    },
    footerHost: sidebar.querySelector<HTMLElement>('[data-desktop-footer]') ?? undefined,
    sidebarPreferences: ws.frame.sidebarPreferences, teamPages: teamPageNavigation(),
    importMarkdown: canCreateUnder(null) ? async (file: globalThis.File) => {
      if (!ws.index || !canCreateUnder(null)) throw new Error('Vous ne pouvez pas créer de page dans cet espace.');
      if (ws.metadataAction) throw new Error('Une modification est en cours dans cet espace. Réessayez dans un instant.');
      if (!/\.(md|markdown)$/i.test(file.name)) throw new Error('Choisissez un fichier Markdown (.md ou .markdown).');
      if (file.size > (8 << 20)) throw new Error('Le fichier Markdown doit peser au maximum 8 Mio.');
      ws.metadataAction = true;
      try {
        if (ws.editor) { await ws.editor.isReady; await ws.editor.saver.flush(); }
        await ws.saveOrder;
        const source = await file.text();
        const attempt = await markdownImportAttempt(workspaceKey(ref), file.name, source);
        const id = await repository.importMarkdown(attempt.id, file.name, source);
        const index = adoptIndex(await repository.loadIndex());
        if (!index.pages.some(page => page.id === id)) throw new Error('La page importée est inaccessible.');
        ws.frame.setPages(withSections(index.pages), index.activeId);
        if (ws.frame.element.isConnected && !ws.frame.element.closest('[hidden]')) navigate(id);
        attempt.complete();
      } finally { ws.metadataAction = false; }
    } : undefined,
  });
  ws.footer.addEventListener('blok:desktop-open-library', () => openLibrary());
  ws.footer.addEventListener('blok:desktop-open-agenda', () => {
    if (isCalendarRoute() || !window.dispatchEvent(new Event('blok:open-calendar', {cancelable:true}))) return;
    history.pushState({fromBlokPage:true}, '', calendarUrl(new URL(location.href)));
    onRoute();
  });
  ws.footer.addEventListener('blok:desktop-open-trash', openTrash);
  ws.footer.addEventListener('blok:desktop-open-page', (event) => {
    const detail = (event as CustomEvent<{ pageId: string; seedWelcome?: boolean }>).detail;
    if (!detail?.pageId) return;
    const open = async (): Promise<void> => {
      if (ws.index?.pages.some((page) => page.id === detail.pageId)) {
        navigate(detail.pageId);
        return;
      }
      if (detail.seedWelcome) {
        const id = await seedWelcomeWorkspace();
        if (!id) return;
        const target = ws.index?.pages.some((page) => page.id === detail.pageId) ? detail.pageId : id;
        navigate(target);
      }
    };
    void open().catch(() => undefined);
  });
  if (!ws.footer.parentElement) sidebar.insertBefore(ws.footer, sidebar.querySelector('[data-blok-sidebar-edge]'));
  const observer = new ResizeObserver(() => onLayout(sidebar.getBoundingClientRect().width));
  observer.observe(sidebar);
  ws.frame.element.setAttribute('data-desktop-workspace', '');
  ws.frame.element.toggleAttribute('data-desktop-read-only', ws.access.readOnlyWorkspace);

  async function seedWelcomeWorkspace(): Promise<string | null> {
    if (!ws.index || ws.access.readOnlyWorkspace) return null;
    const workspaceId = ref.kind === 'remote' ? ref.workspaceId : ref.id;
    const key = workspaceKey(ref);
    const existing = ws.index.pages.find((page) => page.id === welcomePageId(workspaceId));
    if (existing) {
      markWelcomeSeeded(key);
      return existing.id;
    }
    const docs = buildWelcomeDocuments(workspaceId, ref.kind === 'remote' && ref.device === true);
    const welcomePage = docs.pages[0];
    if (!welcomePage) return null;
    // Captured so the callbacks below keep the non-null narrowing from the guard.
    const index = ws.index;
    const seeded = await seedWelcomeDocuments({
      docs,
      publishPages: (selectId) => {
        for (const page of docs.pages) {
          if (!index.pages.some((item) => item.id === page.id)) index.pages.push(page);
        }
        ws.frame.setPages(withSections(index.pages), selectId ?? index.activeId);
        saveManifest();
      },
      flushOrder: () => ws.saveOrder,
      seedDocument: async (pageId, document) => {
        if (ref.kind === 'remote') await repository.seedPage(pageId, document);
        else await repository.writePage(pageId, JSON.stringify(document));
      },
    });
    if (seeded) {
      markWelcomeSeeded(key);
      return welcomePage.id;
    }
    index.pages = index.pages.filter((page) => !docs.pages.some((item) => item.id === page.id));
    ws.frame.setPages(withSections(index.pages), index.activeId);
    saveManifest();
    try { await ws.saveOrder; } catch { /* keep empty */ }
    return null;
  }

  function clearDocument(): void {
    ws.coverRowObserver?.disconnect(); ws.coverRowObserver = null;
    board?.destroy(); board = undefined;
    ws.pageToolbar?.destroy(); ws.pageToolbar = null;
    ws.floatingToc?.destroy(); ws.floatingToc = null;
    ws.titleDateMention?.destroy(); ws.titleDateMention = null;
    ws.refreshPagePresentation = null;
    ws.editor?.destroy(); ws.editor = null;
    ws.currentId = '';
    ws.documentStatus = undefined;
    if (!ws.manifestFailed) {
      status.textContent = '';
      status.removeAttribute('data-error');
      status.removeAttribute('data-sync-state');
    }
  }

  async function flushDocument(): Promise<void> {
    editAssistant?.cancel();
    const editor = ws.editor;
    const id = ws.currentId;
    if (editor) {
      await editor.isReady;
      if (ref.kind === 'local') {
        const data = await editor.save();
        await repository.writePage(id, JSON.stringify(data));
      } else await editor.saver.flush();
    }
    await ws.saveOrder;
    if (ws.manifestFailed) throw ws.manifestError ?? new Error('Les pages de l’espace ne sont pas encore enregistrées.');
  }

  function toggleWorkspaceSidebar(): void {
    ws.frame.toggleSidebar();
    onLayout(sidebar.getBoundingClientRect().width);
  }

  function routeLibraryPage(id: string | null, replace = false): void {
    const url = libraryPageUrl(new URL(location.href), id);
    if (url.href !== location.href) {
      const fromPeek = !!libraryPageId(new URL(location.href));
      if (!id && !replace && fromPeek && history.state?.fromLibraryTable) {
        if (window.dispatchEvent(new Event('blok:return-from-library-peek', {cancelable: true}))) history.back();
        return;
      }
      if (replace || fromPeek) history.replaceState(id ? history.state : null, '', url);
      else history.pushState({fromLibraryTable: true}, '', url);
    }
    onRoute();
  }

  function getPeekNeighbors(): [string | undefined, string | undefined] {
    const ids = library?.getVisiblePageIds() ?? [];
    const index = ids.indexOf(libraryPageId(new URL(location.href)) ?? '');
    return index < 0 ? [undefined, undefined] : [ids[index - 1], ids[index + 1]];
  }

  function updatePeekNeighbors(): void {
    const [previous, next] = getPeekNeighbors();
    pageSheet?.setNeighbors(!!previous, !!next);
  }

  async function showLibrary(): Promise<void> {
    if (!ws.index) return;
    const url = new URL(location.href);
    const id = libraryPageId(url);
    if (id && !ws.index.pages.some(page => page.id === id)) {
      routeLibraryPage(null, true);
      return;
    }
    library?.refresh();
    if (openingLibrary === url.href || (library && openingLibrary === undefined && libraryPage === id)) return;
    openingLibrary = url.href;
    const turn = ++libraryRequest;
    ++ws.selection;
    ws.pageCanvas.inert = true;
    try {
      const [, {mountWorkspaceLibrary}, sheetModule] = await Promise.all([
        flushDocument(), import('./workspace-library'), id ? import('./library-page-peek') : null,
      ]);
      if (turn !== libraryRequest || !currentLibrary()) return;
      if (!libraryHistory) {
        // Keep table order while paging through a peek. Actual visits still update global recents.
        libraryHistory = {ids: recentPages.ids, visits: new Map(ws.index.pages.map(page => [page.id, recentPages.visitedAt(page.id)]))};
      }
      if (id && libraryHistory && !libraryHistory.ids.includes(id) && !libraryHistory.visits.get(id)) {
        libraryHistory.ids.unshift(id);
        libraryHistory.visits.set(id, Date.now());
      }
      if (!library) {
        ws.frame.element.setAttribute('data-library-mode', '');
        ws.frame.element.querySelector('[data-blok-sidebar-library]')?.setAttribute('aria-current', 'page');
        if (window.matchMedia('(max-width: 640px)').matches && !sidebar.hasAttribute('data-collapsed')) toggleWorkspaceSidebar();
        libraryHost.hidden = false;
        library = mountWorkspaceLibrary(libraryContent, {
          workspaceName: ref.name,
          pages: () => withSections(ws.index?.pages ?? []),
          recentIds: () => libraryHistory?.ids ?? recentPages.ids,
          visitedAt: page => libraryHistory ? libraryHistory.visits.get(page) : recentPages.visitedAt(page),
          view: () => currentLibrary() ?? 'recents', onViewChange: openLibrary,
          hasTeamspaces: ref.kind === 'remote',
          selectedPageId: () => libraryPageId(new URL(location.href)) ?? undefined,
          onVisiblePagesChange: () => queueMicrotask(updatePeekNeighbors),
          onClosePeek: () => routeLibraryPage(null),
          onOpen: page => {
            if (document.activeElement instanceof HTMLElement) peekReturnFocus = document.activeElement;
            routeLibraryPage(page);
          },
          onToggleSidebar: toggleWorkspaceSidebar, onCreate: ws.access.readOnlyWorkspace ? undefined : () => chooseNewPage(),
          get canCreateTeamspace() { return teamspacePermission.allowed; },
          onCreateTeamspace: createTeamspace,
        });
      }
      pageSheet?.destroy(); pageSheet = undefined;
      if (id && sheetModule) {
        await select(id);
        if (turn !== libraryRequest) return;
        ws.pageCanvas.inert = false;
        pageSheet = sheetModule.mountLibraryPageSheet(libraryHost, ws.pageCanvas, {
          pageId: id, title: ws.index.pages.find(page => page.id === id)?.title ?? '',
          onClose: () => routeLibraryPage(null), onOpenFullPage: () => navigate(id),
          onPrevious: () => { const [previous] = getPeekNeighbors(); if (previous) routeLibraryPage(previous); },
          onNext: () => { const [, next] = getPeekNeighbors(); if (next) routeLibraryPage(next); },
        });
        updatePeekNeighbors();
      } else {
        if (libraryPage && peekReturnFocus?.isConnected) peekReturnFocus.focus({preventScroll: true});
        peekReturnFocus = undefined;
        ++ws.generation;
        clearDocument();
        ws.pageCanvas.replaceChildren();
        ws.pageCanvas.removeAttribute('data-full-width');
        editAssistant = undefined;
        ws.frame.setPages(withSections(ws.index.pages), '');
        ws.assistant.refreshPageActions();
      }
      libraryPage = id;
      library.refresh();
      applyFavicon(undefined);
      document.title = brandedTitle('Bibliothèque');
    } catch (error) {
      if (turn !== libraryRequest || !currentLibrary()) return;
      const last = ws.currentId || ws.index?.activeId;
      if (last) navigate(last, true);
      showError(error);
    } finally {
      if (turn === libraryRequest) { openingLibrary = undefined; ws.pageCanvas.inert = false; }
    }
  }

  async function showCalendar(): Promise<void> {
    if (!ws.index || calendar || openingCalendar !== undefined) return;
    const request = ++ws.selection;
    openingCalendar = request;
    ws.pageCanvas.inert = true;
    try {
      const [, { mountCalendar }, { createCalendarStore }, { createCalendarDirectory }] = await Promise.all([
        flushDocument(), import('./calendar-view'), import('./calendar-store'), import('./calendar-directory'),
      ]);
      if (ws.selection !== request || !isCalendarRoute()) return;
      ws.generation++;
      clearDocument();
      editAssistant = undefined;
      ws.assistant.refreshPageActions();
      ws.pageCanvas.removeAttribute('data-full-width');
      ws.pageCanvas.replaceChildren();
      calendar = mountCalendar(calendarHost, {
        workspaces: createCalendarDirectory(ref),
        onToggleSidebar: toggleWorkspaceSidebar,
        openWorkspacePage: (owner, id) => {
          if (workspaceKey(owner) === workspaceKey(ref)) navigate(id);
          else selectWorkspace(owner, id);
        },
        store: createCalendarStore(ref),
        get pages() { return ws.index?.pages ?? []; },
        canEdit: !ws.access.readOnlyWorkspace,
        openPage: (id) => { if (ws.index?.pages.some(page => page.id === id)) navigate(id); },
        onClose: () => {
          if (!window.dispatchEvent(new Event('blok:return-from-calendar', {cancelable:true}))) return;
          if (history.state?.fromBlokPage) { history.back(); return; }
          if (ws.index?.activeId) navigate(ws.index.activeId);
          else {
            const url = editorUrl(new URL(location.href));
            history.pushState(null, '', url);
            onRoute();
          }
        },
      });
      calendarHost.hidden = false;
      ws.frame.element.setAttribute('data-calendar-mode', '');
      ws.frame.setCalendarActive(true);
      ws.frame.element.toggleAttribute('data-desktop-read-only', ws.access.readOnlyWorkspace);
      applyFavicon(undefined);
      document.title = brandedTitle('Calendrier');
    } catch (error) {
      if (ws.selection !== request || !isCalendarRoute()) return;
      const previousPage = ws.currentId || ws.index?.activeId;
      if (previousPage) navigate(previousPage, true);
      showError(error);
    } finally {
      if (openingCalendar === request) {
        openingCalendar = undefined;
        ws.pageCanvas.inert = false;
      }
    }
  }

  async function showEmptyWorkspace(): Promise<void> {
    editAssistant?.cancel();
    editAssistant = undefined;
    ws.assistant.refreshPageActions();
    if (ws.editor) {
      await ws.editor.isReady;
      if (ref.kind === 'remote') await ws.editor.saver.flush();
    }
    if (ws.index?.pages.length || isCalendarRoute() || currentLibrary()) { onRoute(); return; }
    const key = workspaceKey(ref);
    if (shouldSeedWelcome({
      empty: true,
      seeded: hasWelcomeSeeded(key),
      viewer: ws.access.readOnlyWorkspace,
      remote: ref.kind === 'remote',
    })) {
      const seededId = await seedWelcomeWorkspace();
      if (isCalendarRoute() || currentLibrary()) return;
      if (seededId) {
        navigate(seededId);
        return;
      }
    }
    ws.generation++;
    ws.selection++;
    clearDocument();
    ws.pageCanvas.replaceChildren(createEmptyWorkspaceState(ws.access.readOnlyWorkspace, () => createPage(), {
      onCreateDatabase: () => createPage(null, false, true),
      onInvite: ref.kind === 'remote' && ref.role === 'admin' && !ref.embedded ? () => {
        ws.footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', { detail: 'invites' }));
      } : undefined,
      onGettingStarted: () => {
        void (async () => {
          const id = await seedWelcomeWorkspace();
          if (id) navigate(id);
        })().catch(() => undefined);
      },
    }));
    const url = new URL(location.href);
    if (url.searchParams.has('page')) { clearPageRoute(url); history.replaceState(null, '', url); }
    document.title = brandedTitle(ref.name);
  }

  function onRoute(): void {
    closeTrash?.();
    closeTrash = undefined;
    if (!ws.index) return;
    if (!currentLibrary()) {
      if (openingLibrary !== undefined) { ++ws.selection; ++libraryRequest; openingLibrary = undefined; ws.pageCanvas.inert = false; }
      if (library) {
        pageSheet?.destroy(); pageSheet = undefined;
        libraryHistory = undefined; peekReturnFocus = undefined;
        library.destroy(); library = undefined; libraryPage = undefined; libraryHost.hidden = true;
        ws.frame.element.removeAttribute('data-library-mode');
        ws.frame.element.querySelector('[data-blok-sidebar-library]')?.removeAttribute('aria-current');
      }
    }
    if (isCalendarRoute()) { void showCalendar(); return; }
    if (openingCalendar !== undefined) {
      ws.selection++;
      openingCalendar = undefined;
      ws.pageCanvas.inert = false;
    }
    if (calendar) {
      calendar.destroy();
      calendarHost.hidden = true;
      ws.frame.element.removeAttribute('data-calendar-mode');
      calendar = undefined;
      ws.frame.setCalendarActive(false);
    }
    if (currentLibrary()) { void showLibrary(); return; }
    if (!ws.index.pages.length) { void showEmptyWorkspace().catch(showError); return; }
    const id = pageFromUrl();
    const target = ws.index.pages.find((page) => page.id === id)?.id ?? ws.index.activeId;
    if (id !== target) {
      navigate(target, true);
      return;
    }
    void select(target).catch((error) => {
      // Another tab or sidebar click can start a new navigation while the old
      // editor waits for its save receipt. Only roll back the route that failed.
      if (pageFromUrl() !== target) return;
      if (ws.currentId && pageFromUrl() !== ws.currentId) {
        const url = pageUrlForView(new URL(location.href), ws.currentId, board?.view);
        history.replaceState(null, '', url);
        ws.assistant.refreshPageActions();
      }
      showError(error);
    });
  }

  const openWorkspaceSearch = (): void => {
    if (ws.frame.element.isConnected && !document.querySelector('[aria-modal="true"]')) showPageSearch();
  };
  const openPreferences = (): void => {
    if (ws.frame.element.isConnected && !document.querySelector('[aria-modal="true"]')) {
      ws.footer.dispatchEvent(new Event('blok:desktop-open-preferences'));
    }
  };
  window.addEventListener('blok:desktop-preferences', openPreferences);
  window.addEventListener('blok:desktop-search', openWorkspaceSearch);
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !ws.frame.element.isConnected || event.isComposing) return;
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (event.key === ',') { event.preventDefault(); openPreferences(); }
    else if (['p', 'k'].includes(event.key.toLowerCase())) { event.preventDefault(); openWorkspaceSearch(); }
  });
  function chooseNewPage(parentId: string | null = null, privatePage = false): void {
    if (!ws.index || !canCreateUnder(parentId)) return;
    const destinations: CreationDestination[] = [];
    if (canCreateUnder(null)) {
      destinations.push({ value: 'workspace', label: ref.name, parentId: null });
      if (ref.kind === 'remote') destinations.push({ value: 'private', label: shellText("Privé · Vous uniquement"), parentId: null, privatePage: true });
    }
    destinations.push(...ws.index.pages.filter((page) => canCreateUnder(page.id)).map((page) => ({ value: page.id, label: page.title, parentId: page.id })));
    openPageCreation({ destinations, destination: parentId ?? (privatePage ? 'private' : 'workspace'),
      onCreate: (target, database) => createPage(target.parentId, target.privatePage, database),
    });
  }

  function createPage(parentId: string | null = null, privatePage = false, database = false): void {
    if (!ws.index || ws.metadataAction || !canCreateUnder(parentId)) return;
    const page: DesktopPage = { id: crypto.randomUUID(), title: database ? shellText("Nouvelle base de données") : shellText("Nouvelle page"), parentId, ...(privatePage ? { initialVisibility: 'private' as const } : {}) };
    edits.mark(page.id);
    ws.index.pages.push(page);
    saveManifest();
    void ws.saveOrder.then(async () => {
      if (ws.manifestFailed) return;
      if (database) {
        const document = { title: page.title, blocks: [{ id: crypto.randomUUID(), type: 'database', data: { initialView: 'table', fullPage: true } }] };
        if (ref.kind === 'remote') await repository.seedPage(page.id, document);
        else await repository.writePage(page.id, JSON.stringify(document));
      }
      if (privatePage) await refreshRemoteManifest();
      navigate(page.id);
    }).catch(showError);
  }

  return {
    element: ws.frame.element,
    hasPage: id => ws.index?.pages.some(page => page.id === id) ?? false,
    async start() {
      try {
        const loaded = adoptIndex(await repository.loadIndex());
        refreshDateTitles();
        ws.frame.setPages(withSections(loaded.pages), '');
        onRoute();
        if (pendingSearch && ws.frame.element.isConnected) {
          showPageSearch(pendingSearch.recentIds);
          pendingSearch = undefined;
        }
        scheduleDateRefresh();
        window.addEventListener('focus', refreshDateTitles);
        if (ref.kind === 'remote') {
          void refreshTeamspacePermission();
          window.addEventListener('focus', refreshTeamspacePermission);
          window.addEventListener('focus', () => { void refreshRemoteManifest(); });
          window.setInterval(() => { void refreshRemoteManifest(); }, 15_000);
          window.addEventListener('beforeunload', (event) => {
            const save = ws.documentStatus?.save?.state;
            if (ws.pendingManifests > 0 || ws.manifestFailed || save === 'blocked' || save === 'quarantined') {
              event.preventDefault();
            }
          });
        }
      } catch (error) {
        if (!ws.index) ws.frame.setPagesError?.();
        showError(error);
      }
    },
    async flush() {
      const wasInert = ws.frame.element.inert;
      ws.frame.element.inert = true;
      try {
        await flushDocument();
      } finally { ws.frame.element.inert = wasInert; }
    },
    onRoute,
    toggleSidebar() {
      ws.frame.toggleSidebar();
      onLayout(sidebar.getBoundingClientRect().width);
    },
    createPage,
  };
}
