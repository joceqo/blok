import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {TopBar} from './top-bar';
import type {PageBreadcrumbItem, PageToolbar, PageToolbarOptions} from './types';

/**
 * La barre du haut, montée pour un appelant impératif. `workspace.ts` tient
 * un élément et lui parle par des setters ; React vit derrière ce guichet.
 *
 * `flushSync` au premier rendu parce que l'appelant interroge l'élément dès
 * le retour — sans lui, il trouverait une barre vide.
 */
export function createPageToolbar(
  breadcrumbs: PageBreadcrumbItem[],
  fullWidth: boolean,
  onFullWidthChange: (value: boolean) => void,
  onToggleSidebar?: () => void,
  onShare?: (anchor: HTMLButtonElement) => (() => void) | void,
  options: PageToolbarOptions = {},
): PageToolbar {
  const element = document.createElement('div');
  element.setAttribute('data-desktop-page-toolbar', '');
  const root = createRoot(element);
  const state = {
    items: breadcrumbs.map(item => ({...item})),
    fullWidth,
    favorite: options.favorite === true,
    peers: [] as string[],
  };
  // Les deux surfaces que la barre ouvre ailleurs : l'historique et le
  // partage. On garde de quoi les refermer en partant.
  const open: {history?: () => void; sharing?: (() => void) | void} = {};

  const draw = (sync = false): void => {
    const tree = <TopBar
      items={state.items} container={element} fullWidth={state.fullWidth}
      favorite={state.favorite} peers={state.peers} options={options}
      onFullWidthChange={value => { state.fullWidth = value; onFullWidthChange(value); draw(); }}
      onToggleSidebar={onToggleSidebar}
      onShare={onShare && (anchor => { open.sharing = onShare(anchor); })}
      onHistoryOpen={close => { open.history?.(); open.history = close; }}/>;
    if (sync) flushSync(() => root.render(tree));
    else root.render(tree);
  };
  draw(true);

  const updateCurrent = (change: Partial<Pick<PageBreadcrumbItem, 'title' | 'icon'>>): void => {
    const current = state.items.at(-1);
    if (!current) return;
    state.items = [...state.items.slice(0, -1), {...current, ...change}];
    draw(true);
  };

  return {
    element,
    setBreadcrumbs(value) { state.items = value.map(item => ({...item})); draw(true); },
    setTitle(value) { updateCurrent({title: value}); },
    setIcon(value) { updateCurrent({icon: value}); },
    setFavorite(value) { state.favorite = value; draw(true); },
    setPeers(names) { state.peers = [...names]; draw(true); },
    closeHistory() { open.history?.(); open.history = undefined; },
    destroy() {
      open.sharing?.();
      open.history?.();
      // Démonter pendant le rendu d'un parent est refusé par React ; la barre
      // est détruite depuis un effet de son hôte, donc on attend un tour.
      queueMicrotask(() => root.unmount());
    },
  };
}
