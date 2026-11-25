import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, within } from 'storybook/test';
import { createDesktopFooter } from '../../desktop/src/settings';
import { createPageFrame } from '../shell/sidebar';
import { PreviewClient, shellPreview, type ShellTheme } from './shell-story-fixtures';
import '../shell/sidebar.css';

type Args = { theme: ShellTheme };
const workspace = {
  kind: 'remote', id: 'atelier', name: 'Atelier', workspaceId: 'atelier',
  role: 'admin', server: 'https://blok.example.test', accountId: 'lou',
} as const;

function accessClient() {
  let members = [
    { id: 'lou', name: 'Lou Martin', email: 'lou@example.test', role: 'admin' },
    { id: 'maya', name: 'Maïa Simon', email: 'maya@example.test', role: 'member' },
  ];
  let invites = [{ id: 'anne', email: 'anne@example.test', role: 'viewer', status: 'pending' }];
  let requests = [{ id: 'sacha', email: 'sacha@example.test', message: 'Je rejoins l’équipe design.', status: 'pending' }];

  return new PreviewClient((path, init) => {
    if (path === '/api/session') return { user: members[0], workspaces: [] };
    const [collection, id, decision] = path.replace('/api/workspaces/atelier/', '').split('/');
    const method = init?.method ?? 'GET';
    const data = init?.body ? JSON.parse(String(init.body)) : {};
    switch (collection) {
      case 'notifications': return { notifications: [], unread: 0 };
      case 'members': {
        const member = members.find(entry => entry.id === id);
        if (member?.role === 'admin' && (method === 'DELETE' || method === 'PATCH' && data.role !== 'admin') &&
          members.filter(entry => entry.role === 'admin').length === 1) throw new Error('Conservez au moins un administrateur.');
        if (member && method === 'PATCH') member.role = data.role;
        if (method === 'DELETE') members = members.filter(entry => entry.id !== id);
        return { members };
      }
      case 'invites':
        if (method === 'POST') invites.push({ id: crypto.randomUUID(), email: data.email, role: data.role, status: 'pending' });
        if (method === 'DELETE') invites = invites.filter(entry => entry.id !== id);
        return { invites };
      case 'join-requests': {
        const request = requests.find(entry => entry.id === id);
        if (method === 'POST' && request) {
          if (decision === 'approve') members.push({ id: request.id, name: '', email: request.email, role: data.role });
          requests = requests.filter(entry => entry !== request);
        }
        return { requests };
      }
      default: throw new Error('Cette action est indisponible dans cet aperçu.');
    }
  });
}

function access(theme: ShellTheme, signal: AbortSignal, invitation: boolean) {
  const host = shellPreview(theme);
  const frame = createPageFrame({ pages: [], activeId: '', onOpen() {}, onCreate() {} });
  const footer = createDesktopFooter(() => {}, workspace, frame.headerActions, {sidebarPreferences: frame.sidebarPreferences, client: accessClient(), signal});
  const sidebar = frame.element.querySelector<HTMLElement>('[data-blok-sidebar]')!;
  sidebar.insertBefore(footer, sidebar.querySelector('[data-blok-sidebar-edge]'));
  host.append(frame.element);
  queueMicrotask(() => {
    if (signal.aborted) return;
    footer.dispatchEvent(new CustomEvent('blok:desktop-open-settings', {detail: 'members'}));
    if (invitation) {
      const trigger = document.querySelector<HTMLButtonElement>('[data-cloud-members-toolbar] button');
      trigger?.focus();
      trigger?.click();
    }
  });
  return host;
}

const meta = {
  title: 'Shell/Accès à l’espace', id: 'shell-acces', parameters: {layout: 'fullscreen'},
  args: {theme: 'dark'}, argTypes: {theme: {name: 'Thème', control: 'inline-radio', options: ['light', 'dark']}},
} satisfies Meta<Args>;
export default meta;

export const Membres: StoryObj<Args> = {
  render: ({theme}, {abortSignal}) => access(theme, abortSignal, false),
  play: async ({canvasElement}) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByText('Maïa Simon')).toBeVisible();
    await expect(page.getByRole('searchbox', {name: 'Rechercher parmi les accès'})).toBeEnabled();
  },
};

export const Invitation: StoryObj<Args> = {
  render: ({theme}, {abortSignal}) => access(theme, abortSignal, true),
  play: async ({canvasElement}) => {
    const page = within(canvasElement.ownerDocument.body);
    const invitation = within(await page.findByRole('dialog', {name: 'Ajouter des membres'}));
    await expect(invitation.getByRole('textbox', {name: 'Adresses e-mail'})).toHaveFocus();
  },
};
