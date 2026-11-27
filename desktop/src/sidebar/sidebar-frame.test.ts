import { expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createReactPageFrame } from './sidebar-frame';

it('reveals active ancestors, keeps favorites flat, and applies refreshed page permissions', () => {
  const pages = [
    { id: 'root', parentId: null, section: 'workspace', title: 'Projects', favorite: true },
    { id: 'child', parentId: 'root', title: 'Design' },
  ];
  let editable = true;
  const frame = createReactPageFrame({
    pages,
    activeId: '',
    collapsedByDefault: true,
    teamspace: { name: 'Studio' },
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onLibrary: vi.fn(),
    canCreate: () => editable,
  });
  const rows = () => [...frame.element.querySelectorAll('[data-blok-sidebar-row]')];
  expect(rows()).toHaveLength(2);
  expect(
    frame.element.querySelector('[data-blok-sidebar-favorites] [data-blok-sidebar-toggle]'),
  ).toBeNull();
  editable = false;
  frame.setPages(pages, 'child');
  expect(rows()).toHaveLength(3);
  expect(frame.element.querySelector('[data-blok-sidebar-link][aria-current]')?.textContent).toBe(
    'Design',
  );
  expect(
    rows().every((row) =>
      row.querySelector('button[data-blok-sidebar-add]')?.hasAttribute('hidden'),
    ),
  ).toBe(true);
  expect(frame.element.querySelector('[data-blok-sidebar-teamspace-add]')).toBeNull();
  flushSync(() => frame.sidebarPreferences.set('favorites', false));
  expect(rows()).toHaveLength(2);
});

it('preserves mounted workspace content and stable recent shortcuts when switching modes', () => {
  const pages = ['a', 'b'].map((id) => ({ id, parentId: null, title: id }));
  const save = vi.fn();
  const frame = createReactPageFrame({
    pages,
    activeId: 'a',
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onHome: vi.fn(),
    onChat: vi.fn(),
    onCalendar: vi.fn(),
    onRecentsChange: save,
  });
  const editor = document.createElement('article');
  const inbox = document.createElement('button');
  frame.canvas.append(editor);
  frame.headerActions.prepend(inbox);
  frame.setChatActive(true);
  frame.setCalendarActive(true);
  frame.setPages(pages, 'b');
  expect(save).toHaveBeenCalledTimes(1);
  expect(frame.element.querySelector('[data-blok-sidebar-modes] [aria-current]')?.textContent).toBe(
    'Calendrier',
  );
  frame.setCalendarActive(false);
  frame.setPages(pages, 'b');
  expect(save).toHaveBeenLastCalledWith(['b', 'a']);
  expect(frame.canvas.firstChild).toBe(editor);
  expect(frame.headerActions.firstChild).toBe(inbox);
});

it('keeps navigation available until the page index settles and distinguishes a failure from an empty index', () => {
  const onCalendar = vi.fn();
  const frame = createReactPageFrame({
    pages: [],
    activeId: '',
    loadingPages: true,
    teamspace: { name: 'Studio' },
    onHome: vi.fn(),
    onCalendar,
    onOpen: vi.fn(),
    onCreate: vi.fn(),
  });
  const tree = frame.element.querySelector('nav[aria-label="Pages"]');
  expect(tree?.getAttribute('aria-busy')).toBe('true');
  expect(tree?.textContent).toContain('Studio');
  expect(tree?.textContent).not.toContain('Aucune page');
  tree?.querySelector<HTMLButtonElement>('[data-blok-sidebar-shortcut]')?.click();
  expect(onCalendar).toHaveBeenCalledOnce();
  frame.setPagesError();
  expect(tree?.querySelector('[role="alert"]')).not.toBeNull();
  expect(tree?.querySelector('.sidebar-skeleton')).toBeNull();
  frame.setPages([], '');
  expect(tree?.textContent).toContain('Aucune page');
  frame.setPages([{ id: 'p', title: 'Journal', parentId: null }], 'p');
  frame.setPagesError();
  expect(tree?.textContent).toContain('Journal');
  expect(tree?.hasAttribute('aria-busy')).toBe(false);
  frame.destroy();
});

function teamFrame(hasTeamspaces: boolean) {
  return createReactPageFrame({
    pages: [{ id: 'root', parentId: null, section: 'workspace', title: 'Spec' }],
    activeId: '',
    teamspace: { name: 'Mon espace' },
    hasTeamspaces,
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onHome: vi.fn(),
    onTeamspaces: vi.fn(),
  });
}

it('names the workspace section after its pages, whatever the teamspaces', () => {
  const frame = teamFrame(false);
  const header = frame.element.querySelector(
    '[data-blok-sidebar-section="workspace"] [data-blok-sidebar-section-header] button',
  );
  // La section ne contient que les pages de l'espace : une ligne nommée d'après
  // l'espace de travail, jamais la liste des espaces d'équipe.
  expect(header?.textContent).toBe('Pages de l’espace');
  expect(frame.element.querySelector('[data-blok-sidebar-teamspace] button')?.textContent).toBe(
    'Mon espace',
  );
});

it('offers the teamspaces shortcut only once a teamspace exists', () => {
  // Un espace sans aucune équipe n'a pas de raccourci vers une bibliothèque vide.
  expect(
    teamFrame(false).element.querySelector('[data-blok-sidebar-shortcuts]')?.textContent,
  ).not.toContain('Espaces d’équipe');
  expect(
    teamFrame(true).element.querySelector('[data-blok-sidebar-shortcuts]')?.textContent,
  ).toContain('Espaces d’équipe');
});
