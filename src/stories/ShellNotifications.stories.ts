import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, within } from 'storybook/test';
import { createNotificationTrigger } from '../../desktop/src/cloud/notification-trigger';
import { createPageFrame } from '../shell/sidebar';
import '../shell/sidebar.css';
import type { WorkspaceNotification } from '../../desktop/src/cloud/notifications';
import { PreviewClient, shellPreview } from './shell-story-fixtures';
import type { ShellTheme } from './shell-story-fixtures';

type Args = { theme: ShellTheme };
type Feed = 'empty' | 'unread' | 'error';
const requested = 'Camille demande à rejoindre cet espace.';

function inbox(theme: ShellTheme, feed: Feed, signal: AbortSignal): HTMLElement {
  const host = shellPreview(theme);
  const page = { id: 'roadmap', title: 'Feuille de route', parentId: null };
  const frame = createPageFrame({ pages: [page], activeId: page.id, onOpen() {}, onCreate() {} });
  frame.element.setAttribute('data-desktop-workspace', '');
  const heading = document.createElement('h1');
  heading.textContent = page.title;
  frame.canvas.append(heading);
  host.append(frame.element);
  const items: WorkspaceNotification[] = feed === 'empty' ? [] : [
    { id: 'request', type: 'join_requested', actorName: 'Camille', createdAt: '2026-02-17T10:30:00Z', readAt: null },
    { id: 'approval', type: 'join_approved', actorName: 'Lou', createdAt: '2026-02-16T14:30:00Z', readAt: '2026-02-16T15:00:00Z' },
  ];
  const collection = '/api/workspaces/atelier/notifications';
  let unavailable = feed === 'error';
  const client = new PreviewClient((path, init) => {
    if (unavailable) {
      unavailable = false;
      throw new Error('Notifications indisponibles');
    }
    if (path === collection) return { notifications: items, unreadCount: items.filter(item => !item.readAt).length };
    const item = items.find(entry => path === `${collection}/${entry.id}/read`);
    if (init?.method === 'POST' && item) {
      item.readAt = '2026-02-17T11:00:00Z';
      return { ok: true };
    }
    throw new Error(`Route hors de cet aperçu : ${path}`);
  });
  const trigger = createNotificationTrigger({ client, slug: 'atelier' });
  frame.headerActions.prepend(trigger.element);
  queueMicrotask(() => { if (!signal.aborted) trigger.element.click(); });
  signal.addEventListener('abort', () => trigger.destroy(), { once: true });
  return host;
}

const meta = {
  title: 'Shell/Notifications',
  id: 'shell-notifications',
  parameters: { layout: 'fullscreen' },
  args: { theme: 'light' },
  argTypes: { theme: { name: 'Thème', control: 'inline-radio', options: ['light', 'dark'] } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const Vide: Story = {
  render: ({ theme }, { abortSignal }) => inbox(theme, 'empty', abortSignal),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Aucune notification.')).toBeVisible();
    await expect(within(canvas.getByRole('list', { name: 'Notifications de l’espace' })).queryByRole('listitem')).toBeNull();
  },
};

export const NonLues: Story = {
  name: 'Non lues',
  render: ({ theme }, { abortSignal }) => inbox(theme, 'unread', abortSignal),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(requested)).toBeVisible();
    await expect(within(canvas.getByRole('list', { name: 'Notifications de l’espace' })).getAllByRole('listitem')).toHaveLength(2);
    await expect(canvas.getByRole('button', { name: 'Marquer comme lue' })).toBeVisible();
  },
};

export const Lecture: Story = {
  render: ({ theme }, { abortSignal }) => inbox(theme, 'unread', abortSignal),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Marquer comme lue' }));
    await expect(canvas.queryByRole('button', { name: 'Marquer comme lue' })).toBeNull();
    await expect(canvas.getByText(requested)).toBeVisible();
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
