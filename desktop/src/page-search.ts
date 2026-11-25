import type { ShellPage } from '@blok/sidebar';
import {
  IconChevronDown,
  IconFile,
  IconLink,
  IconLinkExternal,
  IconMessage,
  IconSearch,
  IconSidebarRight,
} from '../../src/components/icons';
import { renderPageIcon } from '../../src/shell/page-icon';
import { COVER_PRESETS } from './cover';
import { createNavigationDialog } from './navigation-modal';

type Page = ShellPage & { cover?: string };
type Chat = { id: string; title: string; excerpt: string };
type ContentMatch = { id: string; excerpt?: string };
interface SearchOptions {
  workspaceName: string;
  pages(): Page[];
  onOpen(id: string): void;
  recentIds?: string[];
  recentOnly?: boolean;
  visitedAt?(id: string): number | undefined;
  pageIdFromLink?(value: string): string | undefined;
  preview?(id: string, signal: AbortSignal): Promise<string>;
  searchContent?(query: string, signal: AbortSignal): Promise<ContentMatch[]>;
  onOpenTab?(id: string): void;
  pageUrl?(id: string): string;
  chats?(): Chat[];
  onOpenChat?(id: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text) node.textContent = text;
  return node;
}
function button(label: string, cls: string, glyph?: string): HTMLButtonElement {
  const node = el('button', cls);
  node.type = 'button';
  if (glyph) {
    node.innerHTML = glyph;
    node.title = label;
    node.setAttribute('aria-label', label);
  } else node.textContent = label;
  return node;
}
function pageIcon(page?: Page): HTMLElement {
  const icon = el('span', 'palette-icon');
  icon.setAttribute('aria-hidden', 'true');
  if (page?.icon) renderPageIcon(icon, page.icon);
  else icon.innerHTML = page ? IconFile : IconMessage;
  return icon;
}
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .trim();
}
function parents(page: Page, index: Map<string, Page>): Page[] {
  const ancestors: Page[] = [],
    seen = new Set([page.id]);
  for (
    let parent = index.get(page.parentId ?? '');
    parent && !seen.has(parent.id);
    parent = index.get(parent.parentId ?? '')
  ) {
    seen.add(parent.id);
    ancestors.unshift(parent);
  }
  return ancestors;
}
function recentGroup(when: number | undefined): string {
  if (!when) return 'Récemment consultées';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(when);
  day.setHours(0, 0, 0, 0);
  const age = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (age <= 0) return 'Aujourd’hui';
  if (age === 1) return 'Hier';
  if (age < 7) return 'Ces 7 derniers jours';
  if (age < 30) return 'Ces 30 derniers jours';
  return 'Plus ancien';
}
type Result = { id: string; title: string; path: string; group: string; excerpt?: string; page?: Page };

export function openPageSearch(options: SearchOptions): () => void {
  const modal = createNavigationDialog('Rechercher dans ' + options.workspaceName);
  const surface = modal.surface;
  surface.setAttribute('data-navigation-search', '');
  surface.classList.add('page-search');
  const prefix = 'page-search-' + crypto.randomUUID();
  let mode: 'pages' | 'chats' = 'pages',
    active = 0,
    showPreview = true;
  let matches: Result[] = [],
    hits = new Map<string, string>();
  let lookup: AbortController | undefined,
    reading: AbortController | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let lastPreview: string | undefined,
    lookupPending = false,
    lookupFailed = false;
  const header = el('div', 'palette-header'),
    loupe = el('span', 'palette-search-icon');
  loupe.innerHTML = IconSearch;
  loupe.setAttribute('aria-hidden', 'true');
  const field = el('input', 'palette-input');
  field.type = 'text';
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.placeholder = 'Rechercher dans ' + options.workspaceName + '…';
  field.setAttribute('role', 'combobox');
  field.setAttribute('aria-label', 'Rechercher dans ' + options.workspaceName);
  field.setAttribute('aria-autocomplete', 'list');
  field.setAttribute('aria-expanded', 'true');
  field.setAttribute('aria-controls', prefix);
  const previewToggle = button('Aperçu', 'palette-icon-button palette-preview-toggle', IconSidebarRight);
  previewToggle.setAttribute('aria-pressed', 'true');
  header.append(loupe, field, previewToggle, surface.querySelector('[data-navigation-close]')!);
  const filters = el('div', 'palette-filters');
  const pageTab = button('Pages', 'palette-tab'),
    chatTab = button('Chats', 'palette-tab');
  filters.append(pageTab);
  if (options.chats && options.onOpenChat) filters.append(chatTab);
  const divider = el('span', 'palette-divider');
  const titleOnly = button('Titre uniquement', 'palette-filter');
  titleOnly.setAttribute('aria-pressed', String(!options.searchContent));
  if (options.searchContent) filters.append(divider, titleOnly);
  const scope = el('label', 'palette-scope'),
    scopeLabel = el('span', 'palette-filter-label', 'Dans');
  const caret = el('span', 'palette-caret');
  caret.innerHTML = IconChevronDown;
  const select = el('select', 'palette-select');
  select.setAttribute('aria-label', 'Limiter à une page et ses sous-pages');
  select.add(new Option('Tout l’espace', ''));
  const initialPages = options.pages();
  const parentIds = new Set(initialPages.map((page) => page.parentId));
  const scopedPages = initialPages.filter((page) => parentIds.has(page.id));
  for (const page of scopedPages) select.add(new Option(page.title || 'Nouvelle page', page.id));
  scope.append(scopeLabel, caret, select);
  if (scopedPages.length) filters.append(scope);
  const body = el('div', 'palette-body'),
    scroll = el('div', 'palette-scroll');
  const list = el('div', 'palette-list');
  list.id = prefix;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Résultats');
  const empty = el('p', 'palette-empty');
  empty.setAttribute('data-navigation-empty', '');
  empty.setAttribute('role', 'status');
  const preview = el('aside', 'palette-preview');
  preview.setAttribute('aria-label', 'Aperçu');
  scroll.append(list, empty);
  body.append(scroll, preview);
  const footer = el('div', 'palette-footer');
  const mac = /Mac|iPhone|iPad/.test(navigator.platform),
    mod = mac ? '⌘' : 'Ctrl';
  function action(label: string, keys: string, run: () => void): HTMLButtonElement {
    const item = button(label, 'palette-action');
    item.replaceChildren(el('kbd', '', keys), document.createTextNode(label));
    item.addEventListener('click', run);
    footer.append(item);
    return item;
  }
  const openAction = action('Ouvrir', '↵', () => open(false));
  const tabAction = action('Nouvel onglet', mod + ' ↵', () => open(true));
  const copyAction = action('Copier le lien', mod + ' L', () => {
    void copy();
  });
  const feedback = el('span', 'palette-feedback');
  feedback.setAttribute('role', 'status');
  footer.append(feedback);
  surface.append(header, filters, body, footer);

  function authorized(item: Result): boolean {
    return mode === 'pages'
      ? options.pages().some((p) => p.id === item.id)
      : !!options.chats?.().some((c) => c.id === item.id);
  }
  function open(newTab: boolean): void {
    const item = matches[active];
    if (!item || !authorized(item)) {
      render();
      return;
    }
    const callback = mode === 'chats' ? options.onOpenChat : newTab ? options.onOpenTab : options.onOpen;
    if (callback) {
      modal.close();
      callback(item.id);
    }
  }
  async function copy(): Promise<void> {
    const item = matches[active];
    if (!item || mode !== 'pages' || !options.pageUrl || !authorized(item)) {
      render();
      return;
    }
    try {
      await navigator.clipboard.writeText(options.pageUrl(item.id));
      feedback.textContent = 'Lien copié';
    } catch {
      feedback.textContent = 'Copie impossible';
    }
  }
  function showCard(item?: Result): void {
    const key = item ? mode + ':' + item.id + ':' + (item.excerpt ?? '') : undefined;
    if (showPreview && key === lastPreview) return;
    reading?.abort();
    lastPreview = showPreview ? key : undefined;
    preview.replaceChildren();
    if (!showPreview || !item) return;
    const cover = el('div', 'palette-cover');
    const preset = COVER_PRESETS.find((c) => c.id === item.page?.cover);
    if (preset) cover.style.backgroundImage = preset.background;
    const tools = el('div', 'palette-card-tools');
    if (mode === 'pages' && options.pageUrl) {
      const link = button('Copier le lien', 'palette-icon-button', IconLink);
      link.onclick = () => {
        void copy();
      };
      tools.append(link);
    }
    const launch = button('Ouvrir', 'palette-icon-button', IconLinkExternal);
    launch.onclick = () => open(false);
    tools.append(launch);
    cover.append(tools);
    const content = el('div', 'palette-card-content');
    const path = el('div', 'palette-card-path', item.path),
      title = el('h3', 'palette-card-title', item.title);
    const excerpt = el('p', 'palette-excerpt', item.excerpt);
    content.append(path, title, excerpt);
    preview.append(cover, content);
    if (mode === 'pages' && options.preview && !item.excerpt) {
      const request = new AbortController();
      reading = request;
      void options
        .preview(item.id, request.signal)
        .then((text) => {
          if (request.signal.aborted) return;
          if (!authorized(item)) {
            render();
            return;
          }
          excerpt.textContent = text;
        })
        .catch(() => {
          /* The page title and path are still available offline. */
        });
    }
  }
  function highlight(scrollIntoView: boolean): void {
    const rows = list.querySelectorAll<HTMLElement>('[role=option]');
    rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === active)));
    const row = rows[active];
    if (row) {
      field.setAttribute('aria-activedescendant', row.id);
      if (scrollIntoView) row.scrollIntoView?.({ block: 'nearest' });
    } else field.removeAttribute('aria-activedescendant');
    for (const item of [openAction, tabAction, copyAction]) item.disabled = !row;
    feedback.textContent = '';
    showCard(matches[active]);
  }
  function render(preserve = false): void {
    const previous = preserve ? matches[active]?.id : undefined;
    const query = normalize(field.value);
    pageTab.setAttribute('aria-pressed', String(mode === 'pages'));
    chatTab.setAttribute('aria-pressed', String(mode === 'chats'));
    scope.hidden = titleOnly.hidden = divider.hidden = mode !== 'pages';
    tabAction.hidden = mode !== 'pages' || !options.onOpenTab;
    copyAction.hidden = mode !== 'pages' || !options.pageUrl;
    list.replaceChildren();
    if (mode === 'chats') {
      matches = (options.chats?.() ?? [])
        .filter((c) => normalize(c.title + ' ' + c.excerpt).includes(query))
        .map((c) => ({ ...c, path: options.workspaceName, group: 'Conversations' }));
    } else {
      const pages = options.pages(),
        index = new Map(pages.map((p) => [p.id, p]));
      const recent = new Map((options.recentIds ?? []).map((id, i) => [id, i]));
      const linked = options.pageIdFromLink?.(field.value.trim());
      const rank = (id: string): number => recent.get(id) ?? Number.MAX_SAFE_INTEGER;
      const ordered = [...pages].sort(
        (a, b) => (options.visitedAt?.(b.id) ?? 0) - (options.visitedAt?.(a.id) ?? 0) || rank(a.id) - rank(b.id),
      );
      const results: Result[] = [];
      for (const page of ordered) {
        const chain = parents(page, index);
        if (select.value && page.id !== select.value && !chain.some((p) => p.id === select.value)) continue;
        if (linked ? page.id !== linked : !normalize(page.title).includes(query) && !hits.has(page.id)) continue;
        if (!query && options.recentOnly && !recent.has(page.id)) continue;
        const group = query
          ? 'Résultats'
          : recent.has(page.id)
            ? recentGroup(options.visitedAt?.(page.id))
            : 'Pages de l’espace';
        results.push({
          id: page.id,
          title: page.title || 'Nouvelle page',
          path: [options.workspaceName, ...chain.map((p) => p.title)].join(' / '),
          page,
          group,
          excerpt: hits.get(page.id),
        });
      }
      if (query)
        results.sort(
          (a, b) => Number(normalize(b.title).includes(query)) - Number(normalize(a.title).includes(query)),
        );
      matches = results;
    }
    const groups = new Map<string, Result[]>();
    for (const match of matches) {
      const group = groups.get(match.group);
      if (group) group.push(match);
      else groups.set(match.group, [match]);
    }
    matches = [...groups.values()].flat();
    active = Math.max(
      0,
      matches.findIndex((m) => m.id === previous),
    );
    let i = 0;
    for (const [name, items] of groups) {
      const group = el('div', 'palette-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', name);
      const heading = el('div', 'palette-group-heading', name);
      heading.setAttribute('aria-hidden', 'true');
      group.append(heading);
      for (const match of items) {
        const n = i++;
        const row = el('div', 'palette-result');
        row.id = prefix + '-' + n;
        row.setAttribute('role', 'option');
        row.setAttribute('data-navigation-result', '');
        const label = el('span', 'palette-result-title', match.title);
        label.setAttribute('data-navigation-result-title', '');
        const path = el('small', 'palette-result-path', match.path);
        path.setAttribute('data-navigation-result-path', '');
        row.append(pageIcon(match.page), label, path);
        row.addEventListener('pointermove', () => {
          if (active !== n) {
            active = n;
            highlight(false);
          }
        });
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', (e) => {
          active = n;
          open((e.metaKey || e.ctrlKey) && !!options.onOpenTab && mode === 'pages');
        });
        group.append(row);
      }
      list.append(group);
    }
    empty.hidden = matches.length > 0;
    empty.textContent = lookupPending
      ? 'Recherche…'
      : lookupFailed
        ? 'Recherche dans le contenu indisponible.'
        : query
          ? 'Aucun résultat pour « ' + field.value.trim() + ' »'
          : mode === 'chats'
            ? 'Aucune conversation dans cet espace.'
            : 'Aucune page à afficher.';
    highlight(false);
  }
  function update(): void {
    clearTimeout(timer);
    lookup?.abort();
    hits = new Map();
    lookupFailed = false;
    const query = field.value.trim(),
      search = options.searchContent;
    lookupPending = !!(
      query &&
      mode === 'pages' &&
      search &&
      titleOnly.getAttribute('aria-pressed') === 'false' &&
      !options.pageIdFromLink?.(query)
    );
    render();
    scroll.scrollTop = 0;
    if (!lookupPending || !search) return;
    const request = new AbortController();
    lookup = request;
    timer = setTimeout(() => {
      void search(query, request.signal)
        .then((items) => {
          if (request.signal.aborted) return;
          hits = new Map(items.map((hit) => [hit.id, hit.excerpt ?? '']));
          lookupPending = false;
          render(true);
        })
        .catch(() => {
          if (!request.signal.aborted) {
            lookupPending = false;
            lookupFailed = true;
            render(true);
          }
        });
    }, 140);
  }
  pageTab.onclick = () => {
    mode = 'pages';
    update();
    field.focus();
  };
  chatTab.onclick = () => {
    mode = 'chats';
    update();
    field.focus();
  };
  titleOnly.onclick = () => {
    titleOnly.setAttribute('aria-pressed', String(titleOnly.getAttribute('aria-pressed') !== 'true'));
    update();
    field.focus();
  };
  select.onchange = () => {
    scopeLabel.textContent = select.value ? 'Dans ' + select.selectedOptions[0].text : 'Dans';
    render();
    field.focus();
  };
  previewToggle.onclick = () => {
    showPreview = !showPreview;
    preview.hidden = !showPreview;
    previewToggle.setAttribute('aria-pressed', String(showPreview));
    showCard(matches[active]);
  };
  field.addEventListener('input', update);
  surface.addEventListener('keydown', (e) => {
    if (e.isComposing || e.target !== field) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l' && mode === 'pages' && options.pageUrl) {
      e.preventDefault();
      void copy();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, Math.min(matches.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      highlight(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(!!(e.metaKey || e.ctrlKey) && mode === 'pages' && !!options.onOpenTab);
    }
  });
  render();
  modal.open(field, () => {
    clearTimeout(timer);
    lookup?.abort();
    reading?.abort();
  });
  return modal.close;
}
