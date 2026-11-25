import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, within } from 'storybook/test';
import { createPageFrame, type ShellPage } from '../shell/sidebar';
import { mountAgentAssistant } from '../shell/agent-assistant';
import { openPageSearch } from '../../desktop/src/page-search';
import { createPageToolbar } from '../../desktop/src/page-toolbar';
import { createDesktopFooter } from '../../desktop/src/settings';
import type { RemoteWorkspace } from '../../desktop/src/workspace-registry';
import '../../desktop/src/navigation-dialogs.css';
import '../shell/sidebar.css';
import type { WorkspaceNotification } from '../../desktop/src/cloud/notifications';
import { PreviewClient, shellPreview } from './shell-story-fixtures';
import type { ShellTheme } from './shell-story-fixtures';

type Args = { theme: ShellTheme };
type Feed = 'empty' | 'unread' | 'error' | 'decisions';

function inbox(theme: ShellTheme, feed: Feed, signal: AbortSignal): HTMLElement {
  const host = shellPreview(theme);
  const workspace: RemoteWorkspace = {
    kind:'remote', id:'atelier', workspaceId:'atelier', name:'Atelier', server:'https://blok.example.test',
    role:'admin', accountId:'lou', userName:'Lou',
  };
  const pages: ShellPage[] = [{ id: 'roadmap', title: 'Feuille de route', parentId: null, section: 'Privé' }];
  let current = pages[0];
  let closeSearch: (() => void) | undefined;
  const frame = createPageFrame({
    pages, activeId: current.id, collapsedByDefault: true, availableActions: [],
    onOpen: selectPage,
    onCreate(parentId) {
      const page = { id: crypto.randomUUID(), title: 'Nouvelle page', parentId, section: 'Privé' };
      pages.push(page);
      selectPage(page.id);
    },
    onSearch() {
      closeSearch?.();
      closeSearch = openPageSearch({ workspaceName: workspace.name, pages: () => pages, recentIds: [current.id], onOpen: selectPage });
    },
  });
  frame.element.setAttribute('data-desktop-workspace', '');
  const article = document.createElement('article');
  article.setAttribute('data-desktop-document', '');
  const heading = document.createElement('h1');
  heading.textContent = current.title;
  const toolbar = createPageToolbar([current], false,
    full => article.toggleAttribute('data-full-width', full), () => frame.toggleSidebar()
  );
  article.append(heading);
  const pageShell = mountAgentAssistant({
    getPageText: () => article.textContent ?? '',
    listProviders: async () => [],
    openSettings: () => footer.dispatchEvent(new Event('blok:desktop-open-ai-settings')),
  });
  pageShell.editorSlot.append(toolbar.element, article);
  frame.canvas.append(pageShell.element);
  function selectPage(id: string): void {
    const page = pages.find(candidate => candidate.id === id);
    if (!page) return;
    current = page;
    heading.textContent = page.title;
    toolbar.setBreadcrumbs([page]);
    frame.setPages(pages, id);
  }
  host.append(frame.element);
  const items: WorkspaceNotification[] = feed === 'empty' ? [] : feed === 'decisions' ? [
    { id: 'sept', type: 'join_requested', actorName: 'Camille Martin', workspaceName: 'Atelier', createdAt: '2026-09-16T09:28:00Z',
      readAt: '2026-09-16T09:56:00Z', decision: {status:'approved', actorName:'Lou', isMe:true, at:'2026-09-16T09:56:00Z'} },
    { id: 'dec', type: 'join_requested', actorName: 'Alex', workspaceName: 'Atelier', createdAt: '2025-12-19T12:00:00Z',
      readAt: '2025-12-20T16:18:00Z', decision: {status:'rejected', actorName:'Lou', at:'2025-12-20T16:18:00Z'} },
  ] : [
    { id: 'request', type: 'join_requested', actorName: 'Camille', workspaceName:'Atelier', createdAt: '2026-02-17T10:30:00Z', readAt: null,
      requestPending: true, requestMessage: 'Je prépare la prochaine revue et j’aimerais consulter la feuille de route.' },
    { id: 'approval', type: 'join_approved', actorName: 'Lou', workspaceName:'Atelier', createdAt: '2026-02-16T14:30:00Z', readAt: '2026-02-16T15:00:00Z' },
  ];
  const base = '/api/workspaces/atelier';
  const collection = base + '/notifications';
  const request = items.find(item => item.id === 'request');
  const members = [{id:'lou', email:'lou@example.test', role:'admin'}];
  let unavailable = feed === 'error';
  const client = new PreviewClient((path, init) => {
    if (path === '/api/session') return {
      user:{id:'lou', name:'Lou', email:'lou@example.test'},
      workspaces:[{id:'atelier', slug:'atelier', name:'Atelier', role:'admin'}],
    };
    if (path === collection && unavailable) {
      unavailable = false;
      throw new Error('Notifications indisponibles');
    }
    if (path === collection || path === collection + '?archived=1') {
      return {
        notifications: items.filter(item => Boolean(item.archivedAt) === path.endsWith('?archived=1')).map(item => ({...item})),
        unreadCount: items.filter(item => !item.readAt && !item.archivedAt).length,
      };
    }
    if (path === collection + '/read-all' && init?.method === 'POST') {
      const now = new Date().toISOString();
      for (const item of items) if (!item.archivedAt) item.readAt ??= now;
      return {ok:true};
    }
    if (path === base + '/members') return {members};
    if (path === base + '/invites' && !init?.method) return {invites:[]};
    if (path === base + '/join-requests') return {
      requests: request && !request.decision ? [{id:request.id, email:'camille@example.test', status:'pending'}] : [],
    };
    if (request && !request.decision && init?.method === 'POST') {
      const decisionPath = base + '/join-requests/' + request.id;
      const approved = path === decisionPath + '/approve';
      if (approved || path === decisionPath + '/reject') {
        request.decision = {status:approved ? 'approved' : 'rejected', actorName:'Lou', isMe:true, at:new Date().toISOString()};
        request.requestPending = false;
        if (approved) members.push({id:'camille', email:'camille@example.test', role:JSON.parse(String(init.body)).role});
        return {ok:true};
      }
    }
    if (init?.method === 'POST' && path.startsWith(collection + '/')) {
      const [id, action] = path.slice(collection.length + 1).split('/');
      const item = items.find(entry => entry.id === id);
      if (item) {
        const now = new Date().toISOString();
        switch (action) {
          case 'read': item.readAt ??= now; return {ok:true};
          case 'unread': item.readAt = null; return {ok:true};
          case 'archive': item.archivedAt ??= now; return {ok:true};
          case 'unarchive': item.archivedAt = null; return {ok:true};
        }
      }
    }
    throw new Error(`Route hors de cet aperçu : ${path}`);
  });
  const footer = createDesktopFooter(() => {}, workspace, frame.headerActions, {sidebarPreferences: frame.sidebarPreferences, client, signal});
  const sidebar = frame.element.querySelector<HTMLElement>('[data-blok-sidebar]')!;
  sidebar.insertBefore(footer, sidebar.querySelector('[data-blok-sidebar-edge]'));
  queueMicrotask(() => { if (!signal.aborted) frame.headerActions.querySelector<HTMLButtonElement>('[data-inbox-trigger]')?.click(); });
  signal.addEventListener('abort', () => {
    closeSearch?.();
    pageShell.destroy();
    toolbar.destroy();
  }, { once: true });
  return host;
}

const meta = {
  title: 'Shell/Notifications',
  id: 'shell-notifications',
  parameters: { layout: 'fullscreen' },
  args: { theme: 'dark' },
  argTypes: { theme: { name: 'Thème', control: 'inline-radio', options: ['light', 'dark'] } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const Vide: Story = {
  render: ({ theme }, { abortSignal }) => inbox(theme, 'empty', abortSignal),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Vous êtes à jour.')).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: 'Notifications de l’espace' })).queryByRole('listitem')).toBeNull();
  },
};

export const NonLues: Story = {
  name: 'Non lues',
  render: ({ theme }, { abortSignal }) => inbox(theme, 'unread', abortSignal),
  play: async ({ args, canvasElement, viewMode }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Camille')).toBeVisible();
    if (viewMode === 'story') {
      await expect(canvasElement.ownerDocument.documentElement).toHaveAttribute('data-blok-theme', args.theme);
      await expect(canvasElement.ownerDocument.body).toHaveAttribute('data-blok-theme', args.theme);
    }
    await expect(canvas.getByText('Camille').closest('p')).toHaveTextContent('Camille demande à rejoindre Atelier.');
    await expect(canvas.getByRole('button', { name: 'Rechercher une page' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Espaces et réglages' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Voir les demandes' })).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: 'Notifications de l’espace' })).getAllByRole('listitem')).toHaveLength(2);
    const markRead = canvas.getByRole('button', { name: 'Marquer comme lue' });
    markRead.focus();
    await expect(markRead).toBeVisible();
    markRead.blur();
  },
};

export const Lecture: Story = {
  render: ({ theme }, { abortSignal }) => inbox(theme, 'unread', abortSignal),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const markRead = await canvas.findByRole('button', { name: 'Marquer comme lue' });
    markRead.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.queryByRole('button', { name: 'Marquer comme lue' })).toBeNull();
    await expect(canvas.getByText('Camille')).toBeVisible();
  },
};

export const DemandesTraitees: Story = {
  name: 'Demandes traitées',
  render: ({theme}, {abortSignal}) => inbox(theme, 'decisions', abortSignal),
  play: async ({canvasElement}) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Approuvée par vous/)).toBeVisible();
    await expect(canvas.getByText(/Refusée par Lou/)).toBeVisible();
  },
};

export const Indisponible: Story = {
  render: ({ theme }, { abortSignal }) => inbox(theme, 'error', abortSignal),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Impossible de charger les notifications/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Actualiser' })).toBeEnabled();
  },
};
