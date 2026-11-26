<<<<<<< HEAD
<<<<<<< HEAD
import { promoteToTopLayer, removeFromTopLayer } from '../../src/components/utils/top-layer';
import { renderPageIcon } from '../../src/shell/page-icon';
import { WORKSPACE_ROLES } from './access-vocabulary';
export interface PageToolbar {
  element: HTMLElement;
  setBreadcrumbs(items: PageBreadcrumbItem[]): void;
  setTitle(title: string): void;
  setIcon(icon: string | undefined): void;
  setFavorite(favorite: boolean): void;
  setPeers(names: string[]): void;
  closeHistory(): void;
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

function moveMenuFocus(menu: HTMLElement, event: KeyboardEvent): void {
  const controls = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (!controls.length) return;
  const at = controls.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  switch (event.key) {
    case 'ArrowDown': next = (at + 1) % controls.length; break;
    case 'ArrowUp': next = (at <= 0 ? controls.length : at) - 1; break;
    case 'Home': next = 0; break;
    case 'End': next = controls.length - 1; break;
    default: return;
  }
  event.preventDefault();
  controls[next].focus();
}

export function createPageToolbar(
  breadcrumbs: PageBreadcrumbItem[],
  fullWidth: boolean,
  onFullWidthChange: (value: boolean) => void,
  onToggleSidebar?: () => void,
  onShare?: (anchor: HTMLButtonElement) => (() => void) | void,
  options: {
    viewControls?: HTMLElement;
    workspaceName?: string;
    workspacePages?: () => PageBreadcrumbChoice[];
    pageUrl?: (id: string) => string;
    favorite?: boolean;
    onFavorite?: (favorite: boolean) => void;
    readOnly?: boolean;
    onRename?: () => void;
    onDuplicate?: () => void;
    onDelete?: () => void;
    onHistory?: () => (() => void);
  } = {},
): PageToolbar {
  let closeHistory:(() => void)|undefined;
  let closeSharing: (() => void) | void;
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
  if (options.workspaceName) {
    const workspace = document.createElement('button');
    workspace.type = 'button';
    workspace.setAttribute('data-desktop-page-workspace', '');
    workspace.title = options.workspaceName;
    workspace.append(glyph(['M2 7 8 2l6 5', 'M4 6v7h3V9h2v4h3V6']));
    const name = document.createElement('span');
    name.textContent = options.workspaceName;
    workspace.append(name);
    if (options.workspacePages) {
      workspace.setAttribute('aria-haspopup', 'menu');
      workspace.setAttribute('aria-expanded', 'false');
      workspace.addEventListener('click', () => openBreadcrumbMenu({
        id: 'workspace', title: options.workspaceName!, menuHeading: options.workspaceName,
        menu: options.workspacePages!(),
      }, workspace));
    }
    const separator = document.createElement('span');
    separator.setAttribute('data-desktop-page-breadcrumb-separator', '');
    separator.textContent = '/';
    separator.setAttribute('aria-hidden', 'true');
    identity.append(workspace, separator, trail);
  } else identity.append(trail, local);
  if (options.viewControls) trail.after(options.viewControls);
  if (options.readOnly) {
    const badge = document.createElement('span');
    badge.setAttribute('data-desktop-page-readonly', '');
    badge.textContent = WORKSPACE_ROLES.viewer;
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
    share.addEventListener('click', () => { close(); closeBreadcrumbMenu(); closeSharing = onShare(share); });
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
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const resetFeedback = (): void => {
    clearTimeout(feedbackTimer);
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
    const id = items.at(-1)?.id;
    if (id) url.searchParams.set('page', id);
    void (async () => {
      try {
        await navigator.clipboard.writeText(id ? options.pageUrl?.(id) ?? url.href : url.href);
        if (disposed) return;
        feedback.textContent = 'Lien copié';
        copy.replaceChildren(glyph(['M3 8l3 3 7-7']));
        copy.title = 'Lien copié';
      } catch {
        if (disposed) return;
        feedback.textContent = 'Copie impossible : vérifiez l’autorisation du presse-papiers.';
        copy.title = 'La copie a échoué';
      } finally { copy.disabled = false; }
      feedback.hidden = false;
      feedbackTimer = setTimeout(resetFeedback, 4000);
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
    favorite.title = favorite.getAttribute('aria-label')!;
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
  menu.setAttribute('aria-label', 'Apparence et mise en page');
  menu.tabIndex = -1;
  menu.hidden = true;
  const heading = document.createElement('div');
  heading.setAttribute('data-desktop-page-menu-heading', '');
  heading.textContent = 'Apparence et mise en page';
  const fullWidthButton = document.createElement('button');
  fullWidthButton.type = 'button';
  fullWidthButton.setAttribute('data-desktop-page-full-width', '');
  fullWidthButton.setAttribute('role', 'switch');
  fullWidthButton.setAttribute('aria-label', 'Pleine largeur');
  fullWidthButton.setAttribute('aria-checked', String(fullWidth));
  const label = document.createElement('span');
  label.textContent = 'Pleine largeur';
  const track = document.createElement('span');
  track.setAttribute('data-desktop-page-switch-track', '');
  fullWidthButton.append(label, track);
  fullWidthButton.disabled = options.readOnly === true;
  menu.append(heading, fullWidthButton);
  const peers = document.createElement('span');
  peers.setAttribute('data-desktop-page-peers','');
  peers.hidden = true;
  if (options.onHistory) {
    actions.prepend(peers);
    const history = document.createElement('button');
    history.type='button';
    history.textContent='Historique des versions';
    history.setAttribute('data-desktop-page-command','');
    history.onclick=()=>{ close(true); closeHistory?.(); closeHistory=options.onHistory?.(); };
    menu.append(history);
  }
  const commands = [
    ['Renommer', options.onRename], ['Dupliquer', options.onDuplicate], ['Mettre à la corbeille', options.onDelete],
  ] as const;
  for (const [title, run] of commands) {
    if (!run || options.readOnly) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-desktop-page-command', '');
    if (title === 'Mettre à la corbeille') button.setAttribute('data-danger', '');
    button.textContent = title;
    button.addEventListener('click', () => { close(); run(); });
    menu.append(button);
  }
  actions.append(more, menu);
  toolbar.append(identity, actions);

  const close = (restoreFocus = false): void => {
    if (menu.hidden) return;
    menu.hidden = true;
    removeFromTopLayer(menu);
    more.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    if (restoreFocus) more.focus();
  };
  const outside = (event: PointerEvent): void => {
    if (event.target instanceof Node && (menu.contains(event.target) || more.contains(event.target))) return;
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.target instanceof Node && menu.contains(event.target)) {
      if (event.key === 'Tab') {
        const controls = menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        const boundary = event.shiftKey ? controls[0] : controls[controls.length - 1];
        if (!boundary || document.activeElement === boundary) {
          close(true);
          if (event.shiftKey) event.preventDefault();
        }
      } else moveMenuFocus(menu, event);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  };
  menu.addEventListener('focusout', event => {
    if (!menu.hidden && event.relatedTarget instanceof Node && event.relatedTarget !== more && !menu.contains(event.relatedTarget)) close();
  });
  more.addEventListener('click', () => {
    if (!menu.hidden) {
      close();
      return;
    }
    closeBreadcrumbMenu();
    menu.hidden = false;
    promoteToTopLayer(menu);
    const bounds = more.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(bounds.right - 280, window.innerWidth - 288))}px`;
    menu.style.top = `${bounds.bottom + 6}px`;
    more.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus({preventScroll:true});
  });
  fullWidthButton.addEventListener('click', () => {
    fullWidth = !fullWidth;
    fullWidthButton.setAttribute('aria-checked', String(fullWidth));
    onFullWidthChange(fullWidth);
  });
  const breadcrumbMenu = document.createElement('div');
  breadcrumbMenu.setAttribute('data-desktop-breadcrumb-menu', '');
  breadcrumbMenu.setAttribute('role', 'menu');
  breadcrumbMenu.setAttribute('aria-label', 'Naviguer entre les pages');
  breadcrumbMenu.hidden = true;
  breadcrumbMenu.tabIndex = -1;
  toolbar.append(breadcrumbMenu);
  let activeCrumb: HTMLButtonElement | null = null;
  const closeBreadcrumbMenu = (restoreFocus = false): void => {
    if (breadcrumbMenu.hidden) return;
    breadcrumbMenu.hidden = true;
    removeFromTopLayer(breadcrumbMenu);
    activeCrumb?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) activeCrumb?.focus();
    activeCrumb = null;
    document.removeEventListener('pointerdown', outsideBreadcrumbMenu, true);
    document.removeEventListener('keydown', onBreadcrumbKey, true);
    window.removeEventListener('resize', onBreadcrumbResize);
  };
  const outsideBreadcrumbMenu = (event: PointerEvent): void => {
    if (event.target instanceof Node &&
      (breadcrumbMenu.contains(event.target) || activeCrumb?.contains(event.target))) return;
    closeBreadcrumbMenu();
  };
  const onBreadcrumbKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeBreadcrumbMenu(true);
    }
    if (event.target instanceof Node && breadcrumbMenu.contains(event.target)) moveMenuFocus(breadcrumbMenu, event);
    if (event.key === 'Tab') closeBreadcrumbMenu(true);
  };
  const onBreadcrumbResize = (): void => closeBreadcrumbMenu();
  const openBreadcrumbMenu = (item: PageBreadcrumbItem, anchor: HTMLButtonElement): void => {
    if (activeCrumb === anchor && !breadcrumbMenu.hidden) {
      closeBreadcrumbMenu();
      return;
    }
    closeBreadcrumbMenu();
    close();
    const choices = item.menu ?? [];
    const renderChoices = (level: PageBreadcrumbChoice[], title: string, back?: () => void, expanded = false): void => {
      const changingLevel = !breadcrumbMenu.hidden;
      const heading = document.createElement('div');

      heading.setAttribute('data-desktop-breadcrumb-menu-heading', '');
      heading.textContent = title;
      breadcrumbMenu.replaceChildren(heading);
      if (back) {
        const backButton = document.createElement('button');

        backButton.type = 'button';
        backButton.setAttribute('role', 'menuitem');
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
          children.setAttribute('role', 'menuitem');
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
        morePages.setAttribute('role', 'menuitem');
        morePages.setAttribute('data-desktop-breadcrumb-menu-more', '');
        morePages.textContent = `${level.length - 6} autres`;
        morePages.addEventListener('click', () => renderChoices(level, title, back, true));
        breadcrumbMenu.append(morePages);
      }
      if (changingLevel) breadcrumbMenu.querySelector<HTMLButtonElement>('button')?.focus();
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
    activeCrumb = anchor;
    (breadcrumbMenu.querySelector<HTMLButtonElement>('[aria-current="page"], [data-desktop-breadcrumb-menu-item]') ?? breadcrumbMenu).focus({preventScroll:true});
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outsideBreadcrumbMenu, true);
    document.addEventListener('keydown', onBreadcrumbKey, true);
    window.addEventListener('resize', onBreadcrumbResize);
  };
  let items = breadcrumbs.map((item) => ({ ...item }));
  const paint = (): void => {
    closeBreadcrumbMenu();
    const list = document.createElement('ol');

    items.forEach((item, index) => {
      if (index > 0) {
        const separator = document.createElement('li');

        separator.setAttribute('data-desktop-page-breadcrumb-separator', '');
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '/';
        list.append(separator);
      }
      const entry = document.createElement('li');
      const current = index === items.length - 1;
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
    const current = items.at(-1);

    if (!current) return;
    items = [...items.slice(0, -1), { ...current, ...change }];
    paint();
  };

  return {
    element: toolbar,
    setBreadcrumbs(value) { resetFeedback(); items = value.map((item) => ({ ...item })); paint(); },
    setTitle(value) { updateCurrent({ title: value }); },
    setIcon(value) { updateCurrent({ icon: value }); },
    setFavorite,
    closeHistory() { closeHistory?.(); closeHistory=undefined; },
    setPeers(names) {
      peers.hidden=names.length===0;
      const label=names.join(', ');
      const text=names.length>2 ? names.slice(0,2).join(', ')+' +'+(names.length-2) : label;
      if (peers.textContent!==text) peers.textContent=text;
      peers.title=names.length ? 'Sur cette page · '+label : '';
      peers.setAttribute('aria-label',peers.title);
    },
    destroy() { disposed = true; clearTimeout(feedbackTimer); closeSharing?.(); closeHistory?.(); close(); closeBreadcrumbMenu(); },
  };
}
||||||| f8ef3c6b39
=======
import { promoteToTopLayer, removeFromTopLayer } from '../../src/components/utils/top-layer';
import { renderPageIcon } from '../../src/shell/page-icon';
import { WORKSPACE_ROLES } from './access-vocabulary';
export interface PageToolbar {
  element: HTMLElement;
  setBreadcrumbs(items: PageBreadcrumbItem[]): void;
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
    onRename?: () => void;
    onDuplicate?: () => void;
    onDelete?: () => void;
  } = {},
): PageToolbar {
  const sharing = { close: undefined as (() => void) | void };
  const layout = { fullWidth };
  const crumb = { active: null as HTMLButtonElement | null };
  const trailState = { items: breadcrumbs.map((item) => ({ ...item })) };
  const feedbackState = {
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    disposed: false,
  };
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
  const workspaceName = options.workspaceName;
  const workspacePages = options.workspacePages;
  if (workspaceName) {
    const workspace = document.createElement('button');
    workspace.type = 'button';
    workspace.setAttribute('data-desktop-page-workspace', '');
    workspace.title = workspaceName;
    workspace.append(glyph(['M2 7 8 2l6 5', 'M4 6v7h3V9h2v4h3V6']));
    const name = document.createElement('span');
    name.textContent = workspaceName;
    workspace.append(name);
    if (workspacePages) {
      workspace.setAttribute('aria-haspopup', 'menu');
      workspace.setAttribute('aria-expanded', 'false');
      workspace.addEventListener('click', () => openBreadcrumbMenu({
        id: 'workspace', title: workspaceName, menuHeading: workspaceName,
        menu: workspacePages(),
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
    badge.textContent = WORKSPACE_ROLES.viewer;
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
    share.addEventListener('click', () => { close(); closeBreadcrumbMenu(); sharing.close = onShare(share); });
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
    clearTimeout(feedbackState.timer);
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
    const id = trailState.items.at(-1)?.id;
    if (id) url.searchParams.set('page', id);
    void (async () => {
      try {
        await navigator.clipboard.writeText(id ? options.pageUrl?.(id) ?? url.href : url.href);
        if (feedbackState.disposed) return;
        feedback.textContent = 'Lien copié';
        copy.replaceChildren(glyph(['M3 8l3 3 7-7']));
        copy.title = 'Lien copié';
      } catch {
        if (feedbackState.disposed) return;
        feedback.textContent = 'Copie impossible : vérifiez l’autorisation du presse-papiers.';
        copy.title = 'La copie a échoué';
      } finally { copy.disabled = false; }
      feedback.hidden = false;
      feedbackState.timer = setTimeout(resetFeedback, 4000);
    })();
  });
  actions.append(copy, feedback);
  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.setAttribute('data-desktop-page-favorite', '');
  favorite.append(glyph(['M8 1.8 9.7 6.1l4.6.4-3.5 2.9 1.1 4.5L8 11.5 4.1 13.9l1.1-4.5L1.7 6.5l4.6-.4Z']));
  const setFavorite = (value: boolean): void => {
    const label = value ? 'Retirer des favoris' : 'Ajouter aux favoris';
    favorite.setAttribute('aria-pressed', String(value));
    favorite.setAttribute('aria-label', label);
    favorite.title = label;
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
  menu.setAttribute('aria-label', 'Apparence et mise en page');
  menu.hidden = true;
  const heading = document.createElement('div');
  heading.setAttribute('data-desktop-page-menu-heading', '');
  heading.textContent = 'Apparence et mise en page';
  const fullWidthButton = document.createElement('button');
  fullWidthButton.type = 'button';
  fullWidthButton.setAttribute('data-desktop-page-full-width', '');
  fullWidthButton.setAttribute('role', 'switch');
  fullWidthButton.setAttribute('aria-label', 'Pleine largeur');
  fullWidthButton.setAttribute('aria-checked', String(layout.fullWidth));
  const label = document.createElement('span');
  label.textContent = 'Pleine largeur';
  const track = document.createElement('span');
  track.setAttribute('data-desktop-page-switch-track', '');
  fullWidthButton.append(label, track);
  fullWidthButton.disabled = options.readOnly === true;
  menu.append(heading, fullWidthButton);
  const commands = [
    ['Renommer', options.onRename], ['Dupliquer', options.onDuplicate], ['Mettre à la corbeille', options.onDelete],
  ] as const;
  for (const [title, run] of commands) {
    if (!run || options.readOnly) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-desktop-page-command', '');
    if (title === 'Mettre à la corbeille') button.setAttribute('data-danger', '');
    button.textContent = title;
    button.addEventListener('click', () => { close(); run(); });
    menu.append(button);
  }
  actions.append(more, menu);
  toolbar.append(identity, actions);

  const close = (restoreFocus = false): void => {
    if (menu.hidden) return;
    menu.hidden = true;
    removeFromTopLayer(menu);
    more.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    if (restoreFocus) more.focus();
  };
  const outside = (event: PointerEvent): void => {
    if (event.target instanceof Node && actions.contains(event.target)) return;
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') close();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  };
  more.addEventListener('click', () => {
    if (!menu.hidden) {
      close();
      return;
    }
    closeBreadcrumbMenu();
    menu.hidden = false;
    promoteToTopLayer(menu);
    const bounds = more.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(bounds.right - 280, window.innerWidth - 288))}px`;
    menu.style.top = `${bounds.bottom + 6}px`;
    more.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    fullWidthButton.focus();
  });
  fullWidthButton.addEventListener('click', () => {
    layout.fullWidth = !layout.fullWidth;
    fullWidthButton.setAttribute('aria-checked', String(layout.fullWidth));
    onFullWidthChange(layout.fullWidth);
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
    crumb.active?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) crumb.active?.focus();
    crumb.active = null;
    document.removeEventListener('pointerdown', outsideBreadcrumbMenu, true);
    document.removeEventListener('keydown', onBreadcrumbKey, true);
    window.removeEventListener('resize', onBreadcrumbResize);
  };
  const outsideBreadcrumbMenu = (event: PointerEvent): void => {
    if (event.target instanceof Node &&
      (breadcrumbMenu.contains(event.target) || crumb.active?.contains(event.target))) return;
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
    if (crumb.active === anchor && !breadcrumbMenu.hidden) {
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
    crumb.active = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outsideBreadcrumbMenu, true);
    document.addEventListener('keydown', onBreadcrumbKey, true);
    window.addEventListener('resize', onBreadcrumbResize);
  };
  const paint = (): void => {
    closeBreadcrumbMenu();
    const list = document.createElement('ol');

    trailState.items.forEach((item, index) => {
      if (index > 0) {
        const separator = document.createElement('li');

        separator.setAttribute('data-desktop-page-breadcrumb-separator', '');
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '/';
        list.append(separator);
      }
      const entry = document.createElement('li');
      const current = index === trailState.items.length - 1;
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
    const current = trailState.items.at(-1);

    if (!current) return;
    trailState.items = [...trailState.items.slice(0, -1), { ...current, ...change }];
    paint();
  };

  return {
    element: toolbar,
    setBreadcrumbs(value) { resetFeedback(); trailState.items = value.map((item) => ({ ...item })); paint(); },
    setTitle(value) { updateCurrent({ title: value }); },
    setIcon(value) { updateCurrent({ icon: value }); },
    setFavorite,
    destroy() {
      feedbackState.disposed = true;
      clearTimeout(feedbackState.timer);
      sharing.close?.();
      close();
      closeBreadcrumbMenu();
    },
  };
}
>>>>>>> origin/fix/self-host-review
||||||| f8ef3c6b39
=======
export interface PageToolbar {
  element: HTMLElement;
  setBreadcrumbs(items: PageBreadcrumbItem[]): void;
  setTitle(title: string): void;
  setIcon(icon: string | undefined): void;
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
): PageToolbar {
  const toolbar = document.createElement('div');
  toolbar.setAttribute('data-desktop-page-toolbar', '');
  const identity = document.createElement('div');
  identity.setAttribute('data-desktop-page-identity', '');
  const trail = document.createElement('nav');
  trail.setAttribute('data-desktop-page-breadcrumbs', '');
  trail.setAttribute('aria-label', 'Fil d’Ariane');
  const local = document.createElement('span');
  local.setAttribute('data-desktop-page-local', '');
  local.title = 'Cette page est enregistrée sur cet appareil';
  local.append(glyph(['M2.5 3.5h11v8h-11z', 'M5.5 13.5h5']), document.createTextNode('Sur cet appareil'));
  identity.append(trail, local);

  const actions = document.createElement('div');
  actions.setAttribute('data-desktop-page-actions', '');
  const more = document.createElement('button');
  more.type = 'button';
  more.setAttribute('data-desktop-page-more', '');
  more.setAttribute('aria-label', 'Actions de la page');
  more.setAttribute('aria-haspopup', 'dialog');
  more.setAttribute('aria-expanded', 'false');
  more.append(glyph(['M4 8h.01', 'M8 8h.01', 'M12 8h.01']));
  const menu = document.createElement('div');
  menu.setAttribute('data-desktop-page-menu', '');
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Apparence et mise en page');
  menu.hidden = true;
  const heading = document.createElement('div');
  heading.setAttribute('data-desktop-page-menu-heading', '');
  heading.textContent = 'Apparence et mise en page';
  const fullWidthButton = document.createElement('button');
  fullWidthButton.type = 'button';
  fullWidthButton.setAttribute('data-desktop-page-full-width', '');
  fullWidthButton.setAttribute('role', 'switch');
  fullWidthButton.setAttribute('aria-label', 'Pleine largeur');
  fullWidthButton.setAttribute('aria-checked', String(fullWidth));
  const label = document.createElement('span');
  label.textContent = 'Pleine largeur';
  const track = document.createElement('span');
  track.setAttribute('data-desktop-page-switch-track', '');
  fullWidthButton.append(label, track);
  menu.append(heading, fullWidthButton);
  actions.append(more, menu);
  toolbar.append(identity, actions);

  const close = (restoreFocus = false): void => {
    if (menu.hidden) return;
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    if (restoreFocus) more.focus();
  };
  const outside = (event: PointerEvent): void => {
    if (event.target instanceof Node && actions.contains(event.target)) return;
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  };
  more.addEventListener('click', () => {
    if (!menu.hidden) {
      close();
      return;
    }
    menu.hidden = false;
    more.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    fullWidthButton.focus();
  });
  fullWidthButton.addEventListener('click', () => {
    fullWidth = !fullWidth;
    fullWidthButton.setAttribute('aria-checked', String(fullWidth));
    onFullWidthChange(fullWidth);
  });
  const breadcrumbMenu = document.createElement('div');
  breadcrumbMenu.setAttribute('data-desktop-breadcrumb-menu', '');
  breadcrumbMenu.setAttribute('role', 'menu');
  breadcrumbMenu.setAttribute('aria-label', 'Naviguer entre les pages');
  breadcrumbMenu.hidden = true;
  toolbar.append(breadcrumbMenu);
  let activeCrumb: HTMLButtonElement | null = null;
  const closeBreadcrumbMenu = (restoreFocus = false): void => {
    if (breadcrumbMenu.hidden) return;
    breadcrumbMenu.hidden = true;
    activeCrumb?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) activeCrumb?.focus();
    activeCrumb = null;
    document.removeEventListener('pointerdown', outsideBreadcrumbMenu, true);
    document.removeEventListener('keydown', onBreadcrumbKey, true);
    window.removeEventListener('resize', onBreadcrumbResize);
  };
  const outsideBreadcrumbMenu = (event: PointerEvent): void => {
    if (event.target instanceof Node &&
      (breadcrumbMenu.contains(event.target) || activeCrumb?.contains(event.target))) return;
    closeBreadcrumbMenu();
  };
  const onBreadcrumbKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeBreadcrumbMenu(true);
    }
  };
  const onBreadcrumbResize = (): void => closeBreadcrumbMenu();
  const openBreadcrumbMenu = (item: PageBreadcrumbItem, anchor: HTMLButtonElement): void => {
    if (activeCrumb === anchor && !breadcrumbMenu.hidden) {
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
        if (choice.icon) iconNode.textContent = choice.icon;
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
    const bounds = anchor.getBoundingClientRect();
    const toolbarBounds = toolbar.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);

    breadcrumbMenu.style.left = `${Math.max(8, Math.min(bounds.left - toolbarBounds.left, toolbarBounds.width - width - 8))}px`;
    breadcrumbMenu.hidden = false;
    activeCrumb = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outsideBreadcrumbMenu, true);
    document.addEventListener('keydown', onBreadcrumbKey, true);
    window.addEventListener('resize', onBreadcrumbResize);
  };
  let items = breadcrumbs.map((item) => ({ ...item }));
  const paint = (): void => {
    closeBreadcrumbMenu();
    const list = document.createElement('ol');

    items.forEach((item, index) => {
      if (index > 0) {
        const separator = document.createElement('li');

        separator.setAttribute('data-desktop-page-breadcrumb-separator', '');
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '/';
        list.append(separator);
      }
      const entry = document.createElement('li');
      const current = index === items.length - 1;
      const content = document.createElement(item.menu || item.onOpen ? 'button' : 'span');
      const iconNode = document.createElement('span');
      const titleNode = document.createElement('span');

      entry.setAttribute('data-desktop-page-breadcrumb-item', '');
      entry.setAttribute('data-page-id', item.id);
      if (content instanceof HTMLButtonElement) {
        content.type = 'button';
        if (item.menu) {
          content.setAttribute('aria-haspopup', 'menu');
          content.setAttribute('aria-expanded', 'false');
          content.addEventListener('click', () => openBreadcrumbMenu(item, content));
        } else if (item.onOpen) {
          content.addEventListener('click', item.onOpen);
        }
      }
      if (current) content.setAttribute('aria-current', 'page');
      content.title = item.title;
      iconNode.setAttribute('data-desktop-page-toolbar-icon', '');
      iconNode.setAttribute('aria-hidden', 'true');
      if (item.icon) iconNode.textContent = item.icon;
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
    const current = items.at(-1);

    if (!current) return;
    items = [...items.slice(0, -1), { ...current, ...change }];
    paint();
  };

  return {
    element: toolbar,
    setBreadcrumbs(value) { items = value.map((item) => ({ ...item })); paint(); },
    setTitle(value) { updateCurrent({ title: value }); },
    setIcon(value) { updateCurrent({ icon: value }); },
    destroy() { close(); closeBreadcrumbMenu(); },
  };
}
>>>>>>> origin/feat/desktop-title-date-mentions
