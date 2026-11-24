import { IconSearch, IconLink, IconCopy, IconPencil, IconArrowRightLine, IconClock, IconTrash, IconExpandFullscreen } from '../../src/components/icons';
import { createPositionTracker } from '../../src/components/utils/popover/anchored-position';
import { resolvePosition } from '../../src/components/utils/popover/popover-position';
import { promoteToTopLayer, removeFromTopLayer } from '../../src/components/utils/top-layer';
import { renderPageIcon } from '../../src/shell/page-icon';
import { PAGE_LEVELS, WORKSPACE_ROLES } from './access-vocabulary';
export interface PageToolbar {
  element: HTMLElement;
  setBreadcrumbs(items: PageBreadcrumbItem[]): void;
  setWorkspaceName(name: string): void;
  setTitle(title: string): void;
  setIcon(icon: string | undefined): void;
  setFavorite(favorite: boolean): void;
  destroy(): void;
}

export interface PageBreadcrumbItem {
  id: string;
  title: string;
  icon?: string;
  onOpen?: () => void;
  menuHeading?: string;
  menu?: PageBreadcrumbChoice[];
}

export interface PageBreadcrumbChoice {
  id: string;
  title: string;
  icon?: string;
  current?: boolean;
  children?: PageBreadcrumbChoice[];
  onOpen: () => void;
}

function glyph(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  return svg;
}

export function createPageToolbar(
  breadcrumbs: PageBreadcrumbItem[],
  fullWidth: boolean,
  onFullWidthChange: (value: boolean) => void,
  onToggleSidebar?: () => void,
  onShare?: (anchor: HTMLButtonElement) => (() => void) | void,
  options: {
    workspaceName?: string;
    workspacePages?: () => PageBreadcrumbChoice[];
    pageUrl?: (id: string) => string;
    favorite?: boolean;
    onFavorite?: (favorite: boolean) => void;
    readOnly?: boolean;
    canComment?: boolean;
    onRename?: () => void;
    onDuplicate?: () => void;
    onMove?: () => void;
    onDelete?: () => void;
    onHistory?: () => void;
  } = {},
): PageToolbar {
  const state: {
    closeSharing: (() => void) | void;
    feedbackTimer: ReturnType<typeof setTimeout> | undefined;
    disposed: boolean;
    fullWidth: boolean;
    activeCrumb: HTMLButtonElement | null;
    items: PageBreadcrumbItem[];
    workspaceName: string | undefined;
  } = {closeSharing: undefined, feedbackTimer: undefined, disposed: false, fullWidth,
    activeCrumb: null, items: breadcrumbs.map(item => ({...item})), workspaceName: options.workspaceName};
  const toolbar = document.createElement('div');
  toolbar.setAttribute('data-desktop-page-toolbar', '');
  if (onToggleSidebar) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.setAttribute('data-desktop-sidebar-toggle', '');
    toggle.setAttribute('aria-label', 'Afficher ou masquer la barre latérale');
    toggle.title = 'Afficher ou masquer la barre latérale';
    toggle.append(glyph(['M2 2.5h12v11H2z', 'M6 2.5v11']));
    toggle.addEventListener('click', onToggleSidebar);
    toolbar.append(toggle);
  }
  const identity = document.createElement('div');
  identity.setAttribute('data-desktop-page-identity', '');
  const trail = document.createElement('nav');
  trail.setAttribute('data-desktop-page-breadcrumbs', '');
  trail.setAttribute('aria-label', 'Fil d’Ariane');
  const local = document.createElement('span');
  local.setAttribute('data-desktop-page-local', '');
  local.title = 'Cette page est enregistrée sur cet appareil';
  local.append(glyph(['M2.5 3.5h11v8h-11z', 'M5.5 13.5h5']), document.createTextNode('Sur cet appareil'));
  if (state.workspaceName) {
    const workspace = document.createElement('button');
    workspace.type = 'button';
    workspace.setAttribute('data-desktop-page-workspace', '');
    workspace.title = state.workspaceName;
    workspace.append(glyph(['M2 7 8 2l6 5', 'M4 6v7h3V9h2v4h3V6']));
    const name = document.createElement('span');
    name.textContent = state.workspaceName;
    workspace.append(name);
    if (options.workspacePages) {
      workspace.setAttribute('aria-haspopup', 'menu');
      workspace.setAttribute('aria-expanded', 'false');
      workspace.addEventListener('click', () => openBreadcrumbMenu({
        id: 'workspace', title: state.workspaceName ?? '', menuHeading: state.workspaceName,
        menu: options.workspacePages?.() ?? [],
      }, workspace));
    }
    const separator = document.createElement('span');
    separator.setAttribute('data-desktop-page-breadcrumb-separator', '');
    separator.textContent = '/';
    separator.setAttribute('aria-hidden', 'true');
    identity.append(workspace, separator, trail);
  } else identity.append(trail, local);
  if (options.readOnly) {
    const badge = document.createElement('span');
    badge.setAttribute('data-desktop-page-readonly', '');
    badge.textContent = options.canComment ? PAGE_LEVELS.comment : WORKSPACE_ROLES.viewer;
    identity.append(badge);
  }

  const actions = document.createElement('div');
  actions.setAttribute('data-desktop-page-actions', '');
  // « Qui voit cette page ? » se répond depuis la barre du haut, avant d'avoir
  // à ouvrir quoi que ce soit — c'est ce qui rend les permissions vivables.
  if (onShare) {
    const share = document.createElement('button');
    share.type = 'button';
    share.setAttribute('data-desktop-page-share', '');
    share.textContent = 'Partager';
    share.setAttribute('aria-haspopup', 'dialog');
    share.setAttribute('aria-expanded', 'false');
    share.addEventListener('click', () => { close(); closeBreadcrumbMenu(); state.closeSharing = onShare(share); });
    actions.append(share);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.setAttribute('data-desktop-page-copy', '');
  copy.setAttribute('aria-label', 'Copier le lien de la page');
  copy.title = 'Copier le lien de la page';
  const linkIcon = () => glyph(['M6.5 9.5 9.5 6.5', 'M6 10l-1 1a2.5 2.5 0 0 1-3.5-3.5L4 5', 'M10 6l1-1a2.5 2.5 0 0 1 3.5 3.5L12 11']);
  copy.append(linkIcon());
  const feedback = document.createElement('span');
  feedback.setAttribute('data-desktop-page-feedback', '');
  feedback.setAttribute('role', 'status');
  feedback.hidden = true;
  const resetFeedback = (): void => {
    clearTimeout(state.feedbackTimer);
    feedback.hidden = true;
    feedback.textContent = '';
    copy.replaceChildren(linkIcon());
    copy.title = 'Copier le lien de la page';
  };
  copy.addEventListener('click', () => {
    if (copy.disabled) return;
    resetFeedback();
    copy.disabled = true;
    const url = new URL(location.href);
    url.pathname = '/'; url.search = ''; url.hash = '';
    const id = state.items.at(-1)?.id;
    if (id) url.searchParams.set('page', id);
    void (async () => {
      try {
        await navigator.clipboard.writeText(id ? options.pageUrl?.(id) ?? url.href : url.href);
        if (state.disposed) return;
        feedback.textContent = 'Lien copié';
        copy.replaceChildren(glyph(['M3 8l3 3 7-7']));
        copy.title = 'Lien copié';
      } catch {
        if (state.disposed) return;
        feedback.textContent = 'Copie impossible : vérifiez l’autorisation du presse-papiers.';
        copy.title = 'La copie a échoué';
      } finally { copy.disabled = false; }
      feedback.hidden = false;
      state.feedbackTimer = setTimeout(resetFeedback, 4000);
    })();
  });
  actions.append(copy, feedback);
  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.setAttribute('data-desktop-page-favorite', '');
  favorite.append(glyph(['M8 1.8 9.7 6.1l4.6.4-3.5 2.9 1.1 4.5L8 11.5 4.1 13.9l1.1-4.5L1.7 6.5l4.6-.4Z']));
  const setFavorite = (value: boolean): void => {
    favorite.setAttribute('aria-pressed', String(value));
    favorite.setAttribute('aria-label', value ? 'Retirer des favoris' : 'Ajouter aux favoris');
    favorite.title = value ? 'Retirer des favoris' : 'Ajouter aux favoris';
  };
  setFavorite(options.favorite === true);
  favorite.addEventListener('click', () => {
    const value = favorite.getAttribute('aria-pressed') !== 'true';
    setFavorite(value); options.onFavorite?.(value);
  });
  if (options.onFavorite) actions.append(favorite);
  const more = document.createElement('button');
  more.type = 'button';
  more.setAttribute('data-desktop-page-more', '');
  more.setAttribute('aria-label', 'Actions de la page');
  more.setAttribute('aria-haspopup', 'dialog');
  more.setAttribute('aria-expanded', 'false');
  more.title = 'Actions de la page';
  more.append(glyph(['M3 8h.2', 'M7.9 8h.2', 'M12.8 8h.2']));
  const menu = document.createElement('div');
  menu.setAttribute('data-desktop-page-menu', '');
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Actions de la page');
  menu.hidden = true;
  const icon = (svg: string): HTMLElement => {
    const node = document.createElement('span');
    node.setAttribute('data-desktop-page-action-icon', '');
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = svg.trim().replace(/>\s+</g, '><');
    return node;
  };
  const searchBox = document.createElement('div');
  searchBox.setAttribute('data-desktop-page-action-search', '');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Rechercher une action…';
  search.setAttribute('aria-label', 'Rechercher une action');
  search.autocomplete = 'off';
  search.spellcheck = false;
  searchBox.append(icon(IconSearch), search);
  const group = (name: string): HTMLElement => {
    const section = document.createElement('div');
    section.setAttribute('data-desktop-page-menu-group', '');
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', name);
    return section;
  };
  const commandsGroup = group('Actions');
  const appearanceGroup = group('Affichage');
  const dangerGroup = group('Corbeille');
  const fullWidthButton = document.createElement('button');
  fullWidthButton.type = 'button';
  fullWidthButton.setAttribute('data-desktop-page-full-width', '');
  fullWidthButton.setAttribute('role', 'switch');
  fullWidthButton.setAttribute('aria-label', 'Pleine largeur');
  fullWidthButton.setAttribute('aria-checked', String(state.fullWidth));
  const label = document.createElement('span');
  label.textContent = 'Pleine largeur';
  const track = document.createElement('span');
  track.setAttribute('data-desktop-page-switch-track', '');
  fullWidthButton.append(icon(IconExpandFullscreen), label, track);
  fullWidthButton.disabled = options.readOnly === true;
  appearanceGroup.append(fullWidthButton);
  const entries: Array<{button: HTMLButtonElement; title: string}> = [];
  const command = (title: string, svg: string, run: () => void, section: HTMLElement, attribute = 'data-desktop-page-command'): void => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(attribute, '');
    const text = document.createElement('span');
    text.textContent = title;
    button.append(icon(svg), text);
    if (section === dangerGroup) button.setAttribute('data-danger', '');
    button.addEventListener('click', () => { close(true); run(); });
    entries.push({button, title});
    section.append(button);
  };
  command('Copier le lien', IconLink, () => copy.click(), commandsGroup, 'data-desktop-page-copy-action');
  const commands = [
    ['Renommer', IconPencil, options.onRename], ['Dupliquer', IconCopy, options.onDuplicate],
    ['Déplacer vers…', IconArrowRightLine, options.onMove], ['Historique des versions', IconClock, options.onHistory],
  ] as const;
  for (const [title, svg, run] of commands) {
    if (run && !options.readOnly) command(title, svg, run, commandsGroup);
  }
  entries.push({button: fullWidthButton, title: 'Pleine largeur'});
  if (options.onDelete && !options.readOnly) command('Mettre à la corbeille', IconTrash, options.onDelete, dangerGroup);
  const empty = document.createElement('div');
  empty.setAttribute('data-desktop-page-menu-empty', '');
  empty.setAttribute('role', 'status');
  empty.textContent = 'Aucune action trouvée';
  empty.hidden = true;
  menu.append(searchBox, commandsGroup, appearanceGroup, dangerGroup, empty);
  actions.append(more, menu);
  toolbar.append(identity, actions);

  const reposition = (): void => {
    if (menu.hidden) return;
    const anchor = more.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const available = Math.max(anchor.top - margin - gap, window.innerHeight - anchor.bottom - margin - gap, 0);
    menu.style.maxHeight = `${available}px`;
    const bounds = menu.getBoundingClientRect();
    const position = resolvePosition({
      anchor, popoverSize: {width: bounds.width, height: bounds.height},
      scopeBounds: new DOMRect(margin, margin, Math.max(0, window.innerWidth - margin * 2), Math.max(0, window.innerHeight - margin * 2)),
      viewportSize: {width: window.innerWidth, height: window.innerHeight},
      scrollOffset: {x: 0, y: 0}, offset: gap, alignEnd: true,
      direction: getComputedStyle(more).direction === 'rtl' ? 'rtl' : 'ltr',
    });
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
  };
  const tracker = createPositionTracker(menu, reposition, more);
  const filter = (): void => {
    const normalize = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
    const query = normalize(search.value);
    for (const entry of entries) entry.button.hidden = !normalize(entry.title).includes(query);
    for (const section of [commandsGroup, appearanceGroup, dangerGroup]) {
      section.hidden = !entries.some(({button}) => section.contains(button) && !button.hidden);
    }
    empty.hidden = entries.some(({button}) => !button.hidden);
    menu.scrollTop = 0;
    reposition();
  };
  search.addEventListener('input', filter);
  const close = (restoreFocus = false): void => {
    if (menu.hidden) return;
    tracker.detach();
    menu.hidden = true;
    removeFromTopLayer(menu);
    more.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    if (restoreFocus) more.focus({preventScroll: true});
  };
  const outside = (event: PointerEvent): void => {
    if (event.target instanceof Node && (menu.contains(event.target) || more.contains(event.target))) return;
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') close();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const visible = entries.map(entry => entry.button).filter(button => !button.hidden && !button.disabled);
    if (event.key === 'Enter' && document.activeElement === search) {
      event.preventDefault();
      visible[0]?.click();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = visible.findIndex(button => button === document.activeElement);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : visible.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
      visible[next]?.focus({preventScroll: true});
      visible[next]?.scrollIntoView?.({block: 'nearest'});
    }
  };
  more.addEventListener('click', () => {
    if (!menu.hidden) {
      close();
      return;
    }
    closeBreadcrumbMenu();
    search.value = '';
    filter();
    menu.hidden = false;
    promoteToTopLayer(menu);
    reposition();
    tracker.attach();
    more.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    search.focus({preventScroll: true});
  });
  fullWidthButton.addEventListener('click', () => {
    state.fullWidth = !state.fullWidth;
    fullWidthButton.setAttribute('aria-checked', String(state.fullWidth));
    onFullWidthChange(state.fullWidth);
  });
  const breadcrumbMenu = document.createElement('div');
  breadcrumbMenu.setAttribute('data-desktop-breadcrumb-menu', '');
  breadcrumbMenu.setAttribute('role', 'menu');
  breadcrumbMenu.setAttribute('aria-label', 'Naviguer entre les pages');
  breadcrumbMenu.hidden = true;
  toolbar.append(breadcrumbMenu);
  const closeBreadcrumbMenu = (restoreFocus = false): void => {
    if (breadcrumbMenu.hidden) return;
    breadcrumbMenu.hidden = true;
    removeFromTopLayer(breadcrumbMenu);
    state.activeCrumb?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) state.activeCrumb?.focus();
    state.activeCrumb = null;
    document.removeEventListener('pointerdown', outsideBreadcrumbMenu, true);
    document.removeEventListener('keydown', onBreadcrumbKey, true);
    window.removeEventListener('resize', onBreadcrumbResize);
  };
  const outsideBreadcrumbMenu = (event: PointerEvent): void => {
    if (event.target instanceof Node &&
      (breadcrumbMenu.contains(event.target) || state.activeCrumb?.contains(event.target))) return;
    closeBreadcrumbMenu();
  };
  const onBreadcrumbKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeBreadcrumbMenu(true);
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = [...breadcrumbMenu.querySelectorAll<HTMLButtonElement>('button')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
    if (event.key === 'Tab') closeBreadcrumbMenu();
  };
  const onBreadcrumbResize = (): void => closeBreadcrumbMenu();
  const openBreadcrumbMenu = (item: PageBreadcrumbItem, anchor: HTMLButtonElement): void => {
    if (state.activeCrumb === anchor && !breadcrumbMenu.hidden) {
      closeBreadcrumbMenu();
      return;
    }
    closeBreadcrumbMenu();
    close();
    const choices = item.menu ?? [];
    const renderChoices = (level: PageBreadcrumbChoice[], title: string, back?: () => void, expanded = false): void => {
      const heading = document.createElement('div');

      heading.setAttribute('data-desktop-breadcrumb-menu-heading', '');
      heading.textContent = title;
      breadcrumbMenu.replaceChildren(heading);
      if (back) {
        const backButton = document.createElement('button');

        backButton.type = 'button';
        backButton.setAttribute('data-desktop-breadcrumb-menu-back', '');
        backButton.textContent = '‹ Retour';
        backButton.addEventListener('click', back);
        breadcrumbMenu.append(backButton);
      }
      for (const choice of expanded ? level : level.slice(0, 6)) {
        const row = document.createElement('div');
        const button = document.createElement('button');
        const iconNode = document.createElement('span');
        const titleNode = document.createElement('span');

        row.setAttribute('data-desktop-breadcrumb-menu-row', '');
        if (choice.current) row.setAttribute('data-current', '');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.setAttribute('data-desktop-breadcrumb-menu-item', choice.id);
        if (choice.current) button.setAttribute('aria-current', 'page');
        iconNode.setAttribute('data-desktop-breadcrumb-menu-icon', '');
        iconNode.setAttribute('aria-hidden', 'true');
        if (choice.icon) renderPageIcon(iconNode, choice.icon);
        else iconNode.append(glyph(['M4 2.5h5.2L12.5 6v7.5H4z', 'M9.2 2.5V6h3.3']));
        titleNode.textContent = choice.title;
        button.append(iconNode, titleNode);
        button.addEventListener('click', () => { closeBreadcrumbMenu(); choice.onOpen(); });
        row.append(button);
        const childChoices = choice.children;

        if (childChoices?.length) {
          const children = document.createElement('button');

          children.type = 'button';
          children.setAttribute('data-desktop-breadcrumb-menu-children', '');
          children.setAttribute('aria-label', `Sous-pages de ${choice.title}`);
          children.textContent = '›';
          children.addEventListener('click', () => renderChoices(childChoices, choice.title, () => renderChoices(level, title, back)));
          row.append(children);
        }
        breadcrumbMenu.append(row);
      }
      if (!expanded && level.length > 6) {
        const morePages = document.createElement('button');

        morePages.type = 'button';
        morePages.setAttribute('data-desktop-breadcrumb-menu-more', '');
        morePages.textContent = `${level.length - 6} autres`;
        morePages.addEventListener('click', () => renderChoices(level, title, back, true));
        breadcrumbMenu.append(morePages);
      }
    };

    renderChoices(choices, item.menuHeading ?? 'Pages');
    if (!choices.length) {
      const empty = document.createElement('p');
      empty.setAttribute('data-desktop-breadcrumb-menu-heading', '');
      empty.textContent = 'Aucune page dans cet espace';
      breadcrumbMenu.append(empty);
    }
    const bounds = anchor.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);

    breadcrumbMenu.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`;
    breadcrumbMenu.style.top = `${bounds.bottom + 6}px`;
    breadcrumbMenu.hidden = false;
    promoteToTopLayer(breadcrumbMenu);
    state.activeCrumb = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outsideBreadcrumbMenu, true);
    document.addEventListener('keydown', onBreadcrumbKey, true);
    window.addEventListener('resize', onBreadcrumbResize);
  };
  const paint = (): void => {
    closeBreadcrumbMenu();
    const list = document.createElement('ol');

    state.items.forEach((item, index) => {
      if (index > 0) {
        const separator = document.createElement('li');

        separator.setAttribute('data-desktop-page-breadcrumb-separator', '');
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '/';
        list.append(separator);
      }
      const entry = document.createElement('li');
      const current = index === state.items.length - 1;
      const content = document.createElement(item.menu || item.onOpen ? 'button' : 'span');
      const iconNode = document.createElement('span');
      const titleNode = document.createElement('span');

      entry.setAttribute('data-desktop-page-breadcrumb-item', '');
      entry.setAttribute('data-page-id', item.id);
      if (content instanceof HTMLButtonElement) {
        content.type = 'button';
        // Going to the page wins over listing its siblings. Notion puts the
        // dropdown on the workspace chip, not on a page crumb: clicking a page
        // in the trail goes there. The current page has nowhere to go, so it
        // keeps its menu.
        if (item.onOpen) {
          content.addEventListener('click', item.onOpen);
        } else if (item.menu) {
          content.setAttribute('aria-haspopup', 'menu');
          content.setAttribute('aria-expanded', 'false');
          content.addEventListener('click', () => openBreadcrumbMenu(item, content));
        }
      }
      if (current) content.setAttribute('aria-current', 'page');
      content.title = item.title;
      iconNode.setAttribute('data-desktop-page-toolbar-icon', '');
      iconNode.setAttribute('aria-hidden', 'true');
      if (item.icon) renderPageIcon(iconNode, item.icon);
      else iconNode.append(glyph(['M4 2.5h5.2L12.5 6v7.5H4z', 'M9.2 2.5V6h3.3']));
      titleNode.setAttribute('data-desktop-page-toolbar-title', '');
      titleNode.textContent = item.title;
      content.append(iconNode, titleNode);
      entry.append(content);
      list.append(entry);
    });
    trail.replaceChildren(list);
    trail.scrollLeft = trail.scrollWidth;
  };
  paint();

  const updateCurrent = (change: Partial<Pick<PageBreadcrumbItem, 'title' | 'icon'>>): void => {
    const current = state.items.at(-1);

    if (!current) return;
    state.items = [...state.items.slice(0, -1), { ...current, ...change }];
    paint();
  };

  return {
    element: toolbar,
    setBreadcrumbs(value) { resetFeedback(); state.items = value.map((item) => ({ ...item })); paint(); },
    setWorkspaceName(value) {
      state.workspaceName = value;
      const workspace = identity.querySelector<HTMLButtonElement>('[data-desktop-page-workspace]');
      if (!workspace) return;
      workspace.title = value;
      const name = workspace.querySelector('span');
      if (name) name.textContent = value;
      closeBreadcrumbMenu();
    },
    setTitle(value) { updateCurrent({ title: value }); },
    setIcon(value) { updateCurrent({ icon: value }); },
    setFavorite,
    destroy() { state.disposed = true; clearTimeout(state.feedbackTimer); state.closeSharing?.(); close(); closeBreadcrumbMenu(); },
  };
}
