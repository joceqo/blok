import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, within } from 'storybook/test';
import { mountNotificationList } from '../../desktop/src/cloud/notifications';
import type { WorkspaceNotification } from '../../desktop/src/cloud/notifications';
import { PreviewClient, shellPreview } from './shell-story-fixtures';
import type { ShellTheme } from './shell-story-fixtures';

type Args = { theme: ShellTheme };
type Feed = 'empty' | 'unread' | 'error';
const requested = 'Camille demande à rejoindre cet espace.';

function inbox(theme: ShellTheme, feed: Feed): HTMLElement {
  const host = shellPreview(theme);
  const frame = document.createElement('main');
  frame.setAttribute('data-inbox-dialog', '');
  frame.style.margin = 'clamp(16px, 10vh, 88px) auto';
  host.append(frame);
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
  mountNotificationList(frame, { client, slug: 'atelier' });
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
  render: ({ theme }) => inbox(theme, 'empty'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Aucune notification.')).toBeVisible();
    await expect(canvas.queryByRole('listitem')).toBeNull();
  },
};

export const NonLues: Story = {
  name: 'Non lues',
  render: ({ theme }) => inbox(theme, 'unread'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(requested)).toBeVisible();
    await expect(canvas.getAllByRole('listitem')).toHaveLength(2);
    await expect(canvas.getByRole('button', { name: 'Marquer comme lue' })).toBeVisible();
  },
};

export const Lecture: Story = {
  render: ({ theme }) => inbox(theme, 'unread'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Marquer comme lue' }));
    await expect(canvas.queryByRole('button', { name: 'Marquer comme lue' })).toBeNull();
    await expect(canvas.getByText(requested)).toBeVisible();
  },
};

export const Indisponible: Story = {
  render: ({ theme }) => inbox(theme, 'error'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Impossible de charger les notifications/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Actualiser' })).toBeEnabled();
  },
};
