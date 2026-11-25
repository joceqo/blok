import { createNavigationDialog } from './navigation-modal';
import type { ShellPage } from '@blok/sidebar';
import { IconFile, IconTable } from '../../src/components/icons';
import { renderPageIcon } from '../../src/shell/page-icon';
import { createChoice, wrapSearchField } from './ui/controls';
import './navigation-dialogs.css';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, attribute: string, text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  element.setAttribute(attribute, '');
  if (text !== undefined) element.textContent = text;
  return element;
};
function icon(value?: string, database = false): HTMLElement {
  const element = node('span', 'data-navigation-icon');
  element.setAttribute('aria-hidden', 'true');
  if (value) renderPageIcon(element, value);
  else element.innerHTML = database ? IconTable : IconFile;
  return element;
}

export { createNavigationDialog } from './navigation-modal';
export { openPageSearch } from './page-search';

export function openMovePicker(options: {
  workspaceName: string;
  pages: () => ShellPage[];
  sourceTitle: string;
  destinations: () => Set<string | null>;
  remote: boolean;
  onChoose: (id: string | null) => void;
}): () => void {
  const label = `Déplacer « ${options.sourceTitle} »`;
  return openPagePicker({
    ...options, label, caption: label, searchLabel: 'Rechercher une destination',
    placeholder: 'Rechercher une destination…', verb: 'déplacer',
    notice: options.remote ? 'Les droits hérités de la page et de ses sous-pages peuvent changer selon la destination.' : undefined,
  });
}

type PickerItem = { id: string | null; title: string; parentId: string | null; icon?: string };
function openPagePicker(options: {
  workspaceName: string;
  pages: () => ShellPage[];
  recentIds?: string[];
  pageIdFromLink?: (value: string) => string | undefined;
  destinations?: () => Set<string | null>;
  label: string;
  caption: string;
  searchLabel: string;
  placeholder: string;
  verb: string;
  notice?: string;
  onChoose: (id: string | null) => void;
}): () => void {
  const modal = createNavigationDialog(options.label);
  modal.surface.setAttribute('data-navigation-search', '');
  const input = document.createElement('input');
  input.type = 'search'; input.placeholder = options.placeholder; input.setAttribute('aria-label', options.searchLabel);
  const header = node('div', 'data-navigation-search-header'); header.append(wrapSearchField(input));
  const heading = node('p', 'data-navigation-caption', options.caption);
  const results = node('div', 'data-navigation-results');
  const empty = node('p', 'data-navigation-empty'); empty.setAttribute('role', 'status');
  const footer = node('div', 'data-navigation-help', `↑ ↓ parcourir · Entrée ${options.verb} · Échap fermer`);
  modal.surface.append(header, heading);
  if (options.notice) modal.surface.append(node('p', 'data-navigation-caption', options.notice));
  modal.surface.append(results, empty, footer);
  let selected = 0;
  let matches: PickerItem[] = [];
  const choose = (page: PickerItem): void => {
    // The tree and permissions can change while the dialog is open.
    const allowed = options.destinations ? options.destinations().has(page.id) : options.pages().some((item) => item.id === page.id);
    if (!allowed) { render(); return; }
    modal.close(); options.onChoose(page.id);
  };
  function highlight(): void {
    [...results.querySelectorAll<HTMLButtonElement>('button')].forEach((button, i) => {
      button.toggleAttribute('data-selected', selected === i);
      button.tabIndex = selected === i ? 0 : -1;
    });
    results.querySelector('[data-selected]')?.scrollIntoView?.({ block: 'nearest' });
  }
  function render(): void {
    const pages = options.pages();
    const byId = new Map(pages.map((page) => [page.id, page]));
    const query = input.value.trim().toLocaleLowerCase();
    const source = options.recentIds && !query
      ? options.recentIds.map((id) => byId.get(id)).filter((page): page is ShellPage => !!page) : pages;
    const destinations = options.destinations?.();
    const choices: PickerItem[] = destinations ? source.filter((page) => destinations.has(page.id)) : source;
    if (destinations?.has(null)) choices.unshift({ id: null, title: options.workspaceName, parentId: null });
    const linkedId = options.pageIdFromLink?.(input.value.trim());
    matches = choices.filter((page) => linkedId ? page.id === linkedId : page.title.toLocaleLowerCase().includes(query));
    selected = 0; results.replaceChildren();
    for (const page of matches) {
      const row = node('button', 'data-navigation-result'); row.type = 'button';
      const labels = node('span', 'data-navigation-result-labels');
      labels.append(node('span', 'data-navigation-result-title', page.title || 'Nouvelle page'));
      const path: string[] = []; const seen = new Set([page.id]); let parent = byId.get(page.parentId ?? '');
      while (parent && !seen.has(parent.id)) { seen.add(parent.id); path.unshift(parent.title); parent = byId.get(parent.parentId ?? ''); }
      path.unshift(options.workspaceName);
      labels.append(node('small', 'data-navigation-result-path', page.id === null ? 'Racine de l’espace' : path.join(' / ')));
      row.append(icon(page.icon), labels);
      row.addEventListener('click', () => choose(page)); results.append(row);
    }
    empty.hidden = matches.length > 0;
    empty.textContent = query ? `Aucune page pour « ${input.value.trim()} »` : (options.destinations ? 'Aucune destination disponible.' : 'Aucune page à afficher.');
    highlight();
  }
  input.addEventListener('input', render);
  modal.surface.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selected = Math.max(0, Math.min(matches.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
      highlight();
      if (document.activeElement !== input) results.querySelector<HTMLButtonElement>('[data-selected]')?.focus();
    } else if (event.key === 'Enter' && document.activeElement === input && matches[selected]) {
      event.preventDefault(); choose(matches[selected]);
    }
  });
  render(); modal.open(input);
  return modal.close;
}

export type CreationDestination = { value: string; label: string; parentId: string | null; privatePage?: boolean };
export function openPageCreation(options: {
  destinations: CreationDestination[];
  destination: string;
  onCreate: (destination: CreationDestination, database: boolean) => void;
}): void {
  const modal = createNavigationDialog('Créer une page');
  modal.surface.setAttribute('data-navigation-create', '');
  modal.surface.append(node('h2', 'data-navigation-heading', 'Créer une page'));
  const destination = createChoice({ label: 'Ajouter dans', value: options.destination, options: options.destinations, searchable: true, onChange() {} });
  const row = node('div', 'data-navigation-destination');
  row.append(node('span', 'data-navigation-caption', 'Ajouter dans'), destination.element);
  modal.surface.append(row);
  for (const [database, title, description] of [
    [false, 'Page vide', 'Écrire, ajouter des images et des blocs.'],
    [true, 'Base de données vide', 'Organiser des pages dans une vue table.'],
  ] as const) {
    const button = node('button', 'data-navigation-create-option'); button.type = 'button';
    const labels = node('span', 'data-navigation-result-labels');
    labels.append(node('strong', 'data-navigation-result-title', title), node('small', 'data-navigation-result-path', description));
    button.append(icon(undefined, database), labels);
    button.addEventListener('click', () => {
      const target = options.destinations.find((item) => item.value === destination.value);
      if (!target) return;
      modal.close(); options.onCreate(target, database);
    });
    modal.surface.append(button);
  }
  modal.open(destination.element, () => destination.destroy());
}
