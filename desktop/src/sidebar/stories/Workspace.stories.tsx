import startupHtml from '../../../index.html?raw';
import '../../startup.css';
import { createPageFrame } from '@blok/sidebar';
import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PreviewClient, shellPreview } from '../../../../src/stories/shell-story-fixtures';
import { createTeamspacePreviewClient } from '../../../../src/stories/teamspace-story-fixtures';
import { openWorkspaceInvitation } from '../../cloud/workspace-settings';
import { openTeamspaces } from '../../cloud/teamspaces';
import { createDesktopFooter } from '../../settings';
import { openPageSearch } from '../../page-search';
import { mountWorkspaceLibrary, type LibraryView } from '../../workspace-library';
import { createReactPageFrame } from '../sidebar-frame';
import { mountedElement } from '../sidebar-elements';
import { examplePages, themeControl, type PreviewArgs } from './preview';

interface WorkspaceStoryArgs extends PreviewArgs {
  canCreateTeamspace: boolean;
  loadingPreview: 'progressive' | 'pagesFirst' | 'session' | 'pages';
}

const meta = {
  title: 'Shell/Sidebar TSX/Espace de travail',
  id: 'sidebar-tsx-workspace',
  parameters: { layout: 'fullscreen', controls: { include: ['theme'] } },
  args: { theme: 'dark', loadingPreview: 'progressive', canCreateTeamspace: true },
  argTypes: {
    theme: themeControl,
    canCreateTeamspace: { name: 'Création d’espace autorisée', control: 'boolean' },
    loadingPreview: {
      name: 'Afficher',
      control: {
        type: 'select',
        labels: {
          progressive: 'Notifications puis pages',
          pagesFirst: 'Pages puis notifications',
          session: 'Session en attente',
          pages: 'Pages en attente',
        },
      },
      options: ['progressive', 'pagesFirst', 'session', 'pages'],
    },
  },
} satisfies Meta<WorkspaceStoryArgs>;
export default meta;
type Story = StoryObj<WorkspaceStoryArgs>;
const studio = { kind: 'local', id: 'storybook-studio', name: 'Studio' } as const;

function workspace(
  theme: PreviewArgs['theme'],
  signal: AbortSignal,
  {
    preferenceKey = 'storybook-sidebar',
    canCreateTeamspace = true,
    suggestions = false,
    empty = false,
    reference = false,
    pagesReady,
    inboxReady,
  }: {
    preferenceKey?: string;
    canCreateTeamspace?: boolean;
    suggestions?: boolean;
    empty?: boolean;
    reference?: boolean;
    pagesReady?: Promise<void>;
    inboxReady?: Promise<void>;
  } = {},
) {
  const host = shellPreview(theme);
  const pages = empty ? [] : examplePages();
  const title = document.createElement('h1');
  title.style.margin = '48px';
  const teamClient = createTeamspacePreviewClient();
  const libraryHost = document.createElement('div');
  const state = {
    invitation: undefined as ReturnType<typeof openWorkspaceInvitation> | undefined,
    closeTeamspaces: undefined as (() => void) | undefined,
    library: undefined as ReturnType<typeof mountWorkspaceLibrary> | undefined,
    view: 'recents' as LibraryView,
    activeId: pages.find((page) => page.id === 'design')?.id ?? '',
    closeSearch: undefined as (() => void) | undefined,
  };

  function closePreview() {
    state.closeTeamspaces?.();
    state.closeTeamspaces = undefined;
    state.library?.destroy();
    state.library = undefined;
    libraryHost.remove();
    title.hidden = false;
  }
  function open(id: string) {
    closePreview();
    state.activeId = id;
    frame.setCalendarActive(false);
    frame.setChatActive(false);
    frame.setPages(pages, id);
    title.textContent = pages.find((page) => page.id === id)?.title ?? 'Aucune page';
  }
  function create(parentId: string | null, section = 'workspace') {
    const id = crypto.randomUUID();
    pages.push({ id, parentId, section, updatedAt: Date.now(), title: 'Nouvelle page' });
    open(id);
  }
  function show(mode: 'calendar' | 'chat') {
    closePreview();
    frame.setCalendarActive(mode === 'calendar');
    frame.setChatActive(mode === 'chat');
    title.textContent = mode === 'calendar' ? 'Calendrier' : 'Discussions';
  }
  function createTeamspace() {
    closePreview();
    title.hidden = true;
    frame.canvas.append(libraryHost);
    state.closeTeamspaces = openTeamspaces(
      remoteStudio,
      {
        initialView: 'create',
        pages: () => pages,
        canEdit: () => true,
        open: async (id) => open(id),
      },
      teamClient,
      libraryHost,
    );
  }
  function openLibrary(view: LibraryView = 'recents') {
    state.view = view;
    if (state.library) {
      state.library.refresh();
      return;
    }
    closePreview();
    frame.setCalendarActive(false);
    frame.setChatActive(false);
    title.hidden = true;
    frame.canvas.append(libraryHost);
    state.library = mountWorkspaceLibrary(libraryHost, {
      workspaceName: studio.name,
      pages: () => pages,
      recentIds: () => [state.activeId],
      visitedAt: () => undefined,
      view: () => state.view,
      hasTeamspaces: true,
      onViewChange: openLibrary,
      canCreateTeamspace,
      onCreateTeamspace: createTeamspace,
      onCreate: () => create(null, state.view === 'private' ? 'Privé' : 'workspace'),
      onOpen: open,
    });
  }

  const createFrame = reference
    ? (options: Parameters<typeof createReactPageFrame>[0]) => ({
        ...createPageFrame(options),
        destroy() {},
      })
    : createReactPageFrame;
  const frame = createFrame({
    pages: pagesReady ? [] : pages,
    loadingPages: !!pagesReady,
    activeId: state.activeId,
    teamspace: { name: studio.name },
    collapsedByDefault: true,
    preferenceKey,
    onOpen: open,
    onCreate: create,
    onCreatePrivate: () => create(null, 'Privé'),
    onHome: () => open(state.activeId),
    onCalendar: () => show('calendar'),
    onOpenLibrarySection: openLibrary,
    onInviteMembers: suggestions
      ? () => {
          state.invitation?.close();
          state.invitation = openWorkspaceInvitation({
            client: new PreviewClient(() => ({})),
            slug: 'studio',
            workspaceName: studio.name,
          });
        }
      : undefined,
    onDownloadDesktop: suggestions
      ? () => {
          closePreview();
          title.textContent = 'Téléchargement de Blok simulé dans Storybook';
        }
      : undefined,
    canCreateTeamspace,
    onCreateTeamspace: createTeamspace,
    onConnectCalendar: () =>
      footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', { detail: 'import' })),
    onChat: () => show('chat'),
    onNewChat: () => show('chat'),
    onLibrary: () => openLibrary(),
    onSearch: () => {
      state.closeSearch?.();
      state.closeSearch = openPageSearch({
        workspaceName: studio.name,
        pages: () => pages,
        onOpen: open,
      });
    },
    availableActions: ['rename', 'duplicate'],
    onAction: (action) => {
      const page = pages.find((item) => item.id === action.id);
      if (!page) return;
      if (action.type === 'rename') {
        page.title = action.title;
        open(page.id);
      }
      if (action.type === 'duplicate') {
        const copy = { ...page, id: crypto.randomUUID(), title: `${page.title} (copie)` };
        pages.push(copy);
        open(copy.id);
      }
    },
  });
  frame.element.setAttribute('data-desktop-workspace', '');
  frame.canvas.append(title);
  const sidebar = mountedElement(frame.element.querySelector('aside'), 'sidebar');
  const footerHost = sidebar.querySelector<HTMLElement>('[data-desktop-footer]') ?? undefined;
  const remoteStudio = {
    ...studio,
    kind: 'remote',
    role: 'admin',
    accountId: 'preview',
    workspaceId: 'studio',
    server: 'https://blok.example.test',
  } as const;
  const client =
    inboxReady &&
    new PreviewClient(async (path) => {
      if (path.endsWith('/notifications')) {
        await inboxReady;
        return { notifications: [], unreadCount: 3 };
      }
      if (path === '/api/session')
        return { user: { id: 'preview', email: 'studio@example.test' }, workspaces: [] };
      return {};
    });
  const footer = createDesktopFooter(
    () => {},
    client ? remoteStudio : studio,
    frame.headerActions,
    {
      client,
      footerHost,
      signal,
      sidebarPreferences: frame.sidebarPreferences,
    },
  );
  if (!footerHost) sidebar.insertBefore(footer, sidebar.querySelector('[data-blok-sidebar-edge]'));
  footer.addEventListener('blok:desktop-open-agenda', () => show('calendar'), { signal });
  footer.addEventListener('blok:desktop-open-library', () => openLibrary(), { signal });
  host.append(frame.element);
  if (pagesReady) {
    void pagesReady.then(() => {
      if (!signal.aborted) open(state.activeId);
    });
  } else open(state.activeId);
  signal.addEventListener(
    'abort',
    () => {
      state.closeSearch?.();
      state.invitation?.close();
      closePreview();
      frame.destroy();
    },
    { once: true },
  );
  return host;
}

export const Assembled: Story = {
  name: 'Sidebar complète',
  render: ({ theme }, { abortSignal }) => workspace(theme, abortSignal, { suggestions: true }),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    await userEvent.click(ui.getByRole('button', { name: 'Journal' }));
    await expect(ui.getByRole('heading', { name: 'Journal' })).toBeVisible();
    const tree = mountedElement(
      canvasElement.querySelector<HTMLElement>('[data-blok-sidebar-teamspace-pages]'),
      'teamspace pages',
    );
    await userEvent.click(within(tree).getByRole('button', { name: 'Navigation desktop' }));
    await expect(ui.getByRole('heading', { name: 'Navigation desktop' })).toBeVisible();
  },
};

export const Reference: Story = {
  name: 'Sidebar de référence',
  render: ({ theme }, { abortSignal }) => workspace(theme, abortSignal, { reference: true }),
};

export const Comparison: Story = {
  name: 'Comparer les deux sidebars',
  render: ({ theme }, { abortSignal }) => {
    const comparison = document.createElement('div');
    comparison.style.cssText =
      'display:grid;grid-template-columns:repeat(2,minmax(270px,1fr));height:100vh;overflow:auto';
    for (const reference of [true, false]) {
      const panel = workspace(theme, abortSignal, { reference });
      const heading = document.createElement('h2');
      heading.textContent = reference ? 'Référence' : 'Sidebar TSX';
      heading.style.cssText =
        'font:inherit;margin:0;padding:8px 12px;background:var(--desktop-strip)';
      panel.prepend(heading);
      comparison.append(panel);
    }
    comparison.setAttribute('data-blok-theme', theme);
    return comparison;
  },
};

export const Loading: Story = {
  name: 'Chargement progressif',
  parameters: { controls: { include: ['theme', 'loadingPreview', 'Afficher'] } },
  render: ({ theme, loadingPreview }, { abortSignal }) => {
    const host = shellPreview(theme);
    // Seule la démonstration ralentit les réponses pour rendre les transitions visibles.
    const boot = new DOMParser()
      .parseFromString(startupHtml, 'text/html')
      .querySelector('.startup-sidebar');
    const preview = document.createElement('div');
    if (boot) preview.append(boot);
    host.append(preview);
    if (loadingPreview === 'session') return host;
    if (loadingPreview === 'pages')
      return workspace(theme, abortSignal, { pagesReady: new Promise<void>(() => {}) });
    const timers: number[] = [];
    function responseAfter(ms: number) {
      return new Promise<void>((resolve) => timers.push(window.setTimeout(resolve, ms)));
    }
    timers.push(
      window.setTimeout(() => {
        const pagesFirst = loadingPreview === 'pagesFirst';
        preview.replaceChildren(
          workspace(theme, abortSignal, {
            pagesReady: responseAfter(pagesFirst ? 1000 : 2600),
            inboxReady: responseAfter(pagesFirst ? 2600 : 1000),
          }),
        );
      }, 1500),
    );
    abortSignal.addEventListener('abort', () => timers.forEach(window.clearTimeout), {
      once: true,
    });
    return host;
  },
};

export const Empty: Story = {
  name: 'Espace vide',
  render: ({ theme }, { abortSignal }) => workspace(theme, abortSignal, { empty: true }),
};

export const Footer: Story = {
  name: 'Sélecteur d’espace et réglages',
  render: ({ theme }, { abortSignal }) => {
    const host = shellPreview(theme);
    const sidebar = document.createElement('aside');
    sidebar.setAttribute('data-blok-sidebar', '');
    sidebar.style.height = '100%';
    const footerHost = document.createElement('div');
    footerHost.setAttribute('data-desktop-footer', '');
    footerHost.style.marginTop = 'auto';
    sidebar.append(footerHost);
    host.append(sidebar);
    createDesktopFooter(() => {}, studio, undefined, { footerHost, signal: abortSignal });
    return host;
  },
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    await userEvent.click(await ui.findByRole('button', { name: 'Espace local et réglages' }));
    const settings = await ui.findByRole('menuitem', { name: 'Paramètres' });
    await waitFor(() => expect(settings).toBeVisible());
  },
};

export const Inbox: Story = {
  name: 'Panneau de notifications',
  render: ({ theme }, { abortSignal }) => workspace(theme, abortSignal),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    await userEvent.click(await ui.findByRole('button', { name: 'Notifications' }));
    await expect(await ui.findByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(ui.getByRole('button', { name: 'Fermer les notifications' })).toHaveFocus();
  },
};

export const SectionMenu: Story = {
  name: 'Menu de section',
  render: ({ theme }, { abortSignal }) =>
    workspace(theme, abortSignal, { preferenceKey: 'storybook-section-menu' }),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    const trigger = await ui.findByRole('button', { name: 'Options de Favoris' });
    await userEvent.click(trigger);
    await waitFor(() =>
      expect(ui.getByRole('menuitem', { name: 'Retirer la section' })).toBeVisible(),
    );
  },
};

export const UpcomingEventsMenu: Story = {
  name: 'Événements à venir · menu',
  render: ({ theme }, { abortSignal }) =>
    workspace(theme, abortSignal, { preferenceKey: 'storybook-upcoming-events-menu' }),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    await expect(
      await ui.findByRole('button', { name: 'Connecter votre calendrier' }),
    ).toBeVisible();
    await userEvent.click(ui.getByRole('button', { name: 'Options de Événements à venir' }));
    await waitFor(() => expect(ui.getByRole('menuitem', { name: /Afficher 10/ })).toBeVisible());
  },
};

export const PrivateSection: Story = {
  name: 'Section Privé · actions',
  render: ({ theme }, { abortSignal }) =>
    workspace(theme, abortSignal, { preferenceKey: 'storybook-private-section' }),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    const more = await ui.findByRole('button', { name: 'Options de Privé' });
    more.focus();
    await expect(
      ui.getByRole('button', { name: 'Ouvrir « Privé » dans la bibliothèque' }),
    ).toBeVisible();
    await expect(ui.getByRole('button', { name: 'Créer une page privée' })).toBeVisible();
  },
};

export const PrivateMenu: Story = {
  name: 'Section Privé · menu',
  render: ({ theme }, { abortSignal }) =>
    workspace(theme, abortSignal, {
      preferenceKey: 'storybook-private-menu',
    }),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    await userEvent.click(await ui.findByRole('button', { name: 'Options de Privé' }));
    await waitFor(() => expect(ui.getByRole('menuitem', { name: /^Trier / })).toBeVisible());
    await expect(ui.getByRole('menuitem', { name: /^Afficher / })).toBeVisible();
  },
};

export const OpenInLibrary: Story = {
  name: 'Ouvrir la section dans la bibliothèque',
  render: ({ theme }, { abortSignal }) =>
    workspace(theme, abortSignal, { preferenceKey: 'storybook-library-link' }),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    await expect(
      ui.queryByRole('button', { name: 'Ouvrir « Événements à venir » dans la bibliothèque' }),
    ).toBeNull();
    for (const [section, page] of [
      ['Espaces d’équipe', 'Projets'],
      ['Favoris', 'Navigation desktop'],
      ['Partagé', 'Idées de l’équipe'],
      ['Privé', 'Journal'],
    ]) {
      await userEvent.click(
        await ui.findByRole('button', { name: `Ouvrir « ${section} » dans la bibliothèque` }),
      );
      const library = within(await ui.findByRole('region', { name: 'Bibliothèque' }));
      await expect(library.getByRole('heading', { name: section })).toBeVisible();
      await expect(library.getByText(page, { exact: true })).toBeVisible();
    }
  },
};

export const TeamspaceSection: Story = {
  name: 'Espaces d’équipe · ajouter',
  parameters: {
    controls: { include: ['theme', 'canCreateTeamspace', 'Création d’espace autorisée'] },
  },
  render: ({ theme, canCreateTeamspace }, { abortSignal }) =>
    workspace(theme, abortSignal, { canCreateTeamspace }),
  play: async ({ canvasElement, args }) => {
    const ui = within(canvasElement);
    if (!args.canCreateTeamspace) {
      await expect(ui.queryByRole('button', { name: 'Créer un espace d’équipe' })).toBeNull();
      return;
    }
    const add = await ui.findByRole('button', { name: 'Créer un espace d’équipe' });
    add.focus();
    await userEvent.hover(add);
    await waitFor(() =>
      expect(ui.getByRole('tooltip')).toHaveTextContent('Créer un espace d’équipe'),
    );
  },
};

export const Suggestions: Story = {
  name: 'Suggestions et raccourci masquables',
  render: ({ theme }, { abortSignal }) =>
    workspace(theme, abortSignal, {
      suggestions: true,
      preferenceKey: 'storybook-sidebar-suggestions',
    }),
};
