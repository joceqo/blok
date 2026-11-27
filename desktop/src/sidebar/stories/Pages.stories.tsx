import { WORKSPACE_ROLES } from '../../access-vocabulary';
import type { Meta, StoryObj } from '@storybook/html-vite';
import { useState, useSyncExternalStore } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { NavigationLayout } from '../navigation-layout';
import { SidebarPreferencesMenu } from '../sidebar-customize-menu';
import { createSidebarPreferences } from '../../../../src/shell/sidebar-preferences';
import type { SidebarOptions } from '../sidebar-frame';
import { SidebarTree } from '../sidebar-tree';
import { SidebarPageMenu } from '../sidebar-page-menu';
import { examplePages, isolated, themeControl, type PreviewArgs } from './preview';

type Args = PreviewArgs & { readOnly: boolean };
const meta = {
  title: 'Shell/Sidebar TSX/Pages',
  id: 'sidebar-tsx-pages',
  parameters: { layout: 'fullscreen' },
  args: { theme: 'dark', readOnly: false },
  argTypes: { theme: themeControl, readOnly: { name: WORKSPACE_ROLES.viewer, control: 'boolean' } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

const TreePreview = ({ readOnly }: { readOnly: boolean }) => {
  const [pages, setPages] = useState(examplePages);
  const [expanded, setExpanded] = useState(new Map<string, boolean>());
  const [activeId, setActiveId] = useState('design');
  const [prefs] = useState(() => createSidebarPreferences(undefined, false));
  const visibility = useSyncExternalStore(prefs.subscribe, prefs.getSnapshot);
  const options: SidebarOptions = {
    preferenceKey: 'storybook-isolated-tree',
    onCreatePrivate: () =>
      setPages((items) => [
        ...items,
        { id: crypto.randomUUID(), title: 'Nouvelle page', parentId: null, section: 'Privé' },
      ]),

    pages,
    activeId,
    teamspace: { name: 'Studio' },
    onOpen: setActiveId,
    onCreate: fn(),
    availableActions: ['rename'],
    canEdit: () => !readOnly,
    canCreate: () => !readOnly,
    onAction: (action) => {
      if (action.type === 'rename')
        setPages((items) =>
          items.map((page) => (page.id === action.id ? { ...page, title: action.title } : page)),
        );
    },
  };
  return (
    <NavigationLayout
      mode="home"
      options={options}
      prefs={prefs}
    >
      <SidebarTree
        pages={pages}
        activeId={activeId}
        expanded={expanded}
        recents={[]}
        query=""
        options={options}
        visibility={visibility}
        onExpand={(id, open) => setExpanded((items) => new Map(items).set(id, open))}
        onFavorite={(id) =>
          setPages((items) =>
            items.map((page) => (page.id === id ? { ...page, favorite: !page.favorite } : page)),
          )
        }
      />
      <SidebarPreferencesMenu
        prefs={prefs}
        pages={pages}
      />
    </NavigationLayout>
  );
};

export const Tree: Story = {
  name: 'Arbre, sections et favoris',
  render: ({ theme, readOnly }, { abortSignal }) =>
    isolated(theme, abortSignal, <TreePreview readOnly={readOnly} />),
};

const MenuPreview = ({ readOnly }: { readOnly: boolean }) => {
  const [page, setPage] = useState({
    id: 'design',
    parentId: null,
    title: 'Navigation desktop',
    favorite: false,
  });
  const [offline, setOffline] = useState(false);
  return (
    <div data-blok-sidebar-row="">
      <button
        type="button"
        data-blok-sidebar-link=""
        onClick={fn()}
      >
        {page.title}
      </button>
      <SidebarPageMenu
        page={page}
        offline={offline}
        toggleOffline={() => setOffline((on) => !on)}
        onFavorite={() => setPage((item) => ({ ...item, favorite: !item.favorite }))}
        onRename={fn()}
        options={{
          pages: [page],
          activeId: page.id,
          onOpen: fn(),
          onCreate: fn(),
          onAction: fn(),
          canEdit: () => !readOnly,
        }}
      />
    </div>
  );
};

export const PageMenu: Story = {
  name: 'Menu de page',
  render: ({ theme, readOnly }, { abortSignal }) =>
    isolated(theme, abortSignal, <MenuPreview readOnly={readOnly} />),
  play: async ({ canvasElement, args }) => {
    const ui = within(canvasElement);
    await userEvent.click(ui.getByRole('button', { name: 'Navigation desktop' }));
    await userEvent.click(ui.getByRole('button', { name: 'Actions de la page' }));
    await waitFor(() => expect(ui.getByRole('menu')).toBeVisible());
    if (args.readOnly) await expect(ui.queryByRole('menuitem', { name: 'Renommer' })).toBeNull();
    else await expect(ui.getByRole('menuitem', { name: 'Renommer' })).toBeVisible();
  },
};
export const ReadOnlyMenu: Story = {
  ...PageMenu,
  name: 'Menu en lecture seule',
  args: { readOnly: true },
};
