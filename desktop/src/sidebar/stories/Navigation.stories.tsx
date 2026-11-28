import type { Meta, StoryObj } from '@storybook/html-vite';

import { SidebarModes } from '../../sidebar-modes';
import { createNotificationTrigger } from '../../cloud/notification-trigger';
import { mountSidebarInbox } from '../sidebar-inbox';
import { createRef, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { createSidebarPreferences } from '../../../../src/shell/sidebar-preferences';
import type { SidebarMode } from '../../sidebar-modes';
import { SidebarHeader, SidebarPreferencesMenu, SidebarSearch, SidebarShortcuts } from '../sidebar';
import { SidebarResize } from '../sidebar-resize';
import { isolated, themeControl, type PreviewArgs } from './preview';

const options = { pages: [], activeId: '', onOpen: fn(), onCreate: fn() };
const meta = {
  title: 'Shell/Sidebar TSX/Navigation',
  id: 'sidebar-tsx-navigation',
  parameters: { layout: 'fullscreen' },
  args: { theme: 'dark' },
  argTypes: { theme: themeControl },
} satisfies Meta<PreviewArgs>;
export default meta;
type Story = StoryObj<PreviewArgs>;

const TabsPreview = () => {
  const [active, setActive] = useState<SidebarMode>('home');
  return (
    <SidebarModes
      active={active}
      onHome={() => setActive('home')}
      onChat={() => setActive('chat')}
      onCalendar={() => setActive('calendar')}
    />
  );
};

export const ModeItem: Story = {
  name: 'Onglets · infobulle et raccourci',
  render: ({ theme }, { abortSignal }) => isolated(theme, abortSignal, <TabsPreview />),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    const chat = await ui.findByRole('button', { name: 'Discussions' });
    await userEvent.keyboard('{Control>}2{/Control}');
    await waitFor(() => expect(chat).toHaveAttribute('aria-current', 'page'));
    await userEvent.keyboard('{Control>}1{/Control}');
    await userEvent.hover(chat);
    // L’aperçu s’ouvre sur l’infobulle telle qu’elle apparaît au survol.
    await waitFor(() => {
      const tooltip = ui.getByRole('tooltip');
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent(/Discussions.*(⌃2|Ctrl\+2)/);
    });
  },
};

export const Header: Story = {
  name: 'En-tête',
  render: ({ theme }, { abortSignal }) => {
    const actions = createRef<HTMLDivElement>();
    const host = isolated(
      theme,
      abortSignal,
      <SidebarHeader
        options={options}
        headerActions={actions}
        toggleSidebar={fn()}
      />,
    );
    const inbox = createNotificationTrigger(undefined, mountSidebarInbox());
    actions.current?.prepend(inbox.element);
    abortSignal.addEventListener('abort', inbox.destroy, { once: true });
    return host;
  },
};

export const Search: Story = {
  name: 'Recherche',
  render: ({ theme }, { abortSignal }) =>
    isolated(
      theme,
      abortSignal,
      <SidebarSearch
        onSearch={fn()}
        onFilter={fn()}
      />,
    ),
};

const ShortcutsPreview = () => {
  const [mode, setMode] = useState<SidebarMode>('home');
  return (
    <SidebarShortcuts
      mode={mode}
      recents={[]}
      options={{
        ...options,
        onHome: () => setMode('home'),
        onChat: () => setMode('chat'),
        onCalendar: () => setMode('calendar'),
        onNewChat: fn(),
        onLibrary: fn(),
      }}
    />
  );
};

export const Shortcuts: Story = {
  name: 'Modes et raccourcis',
  render: ({ theme }, { abortSignal }) => isolated(theme, abortSignal, <ShortcutsPreview />),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    await userEvent.click(ui.getByRole('button', { name: 'Calendrier' }));
    await expect(ui.getByRole('button', { name: 'Calendrier' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await userEvent.click(ui.getByRole('button', { name: 'Accueil' }));
  },
};

export const Preferences: Story = {
  name: 'Personnalisation',
  render: ({ theme }, { abortSignal }) =>
    isolated(
      theme,
      abortSignal,
      <SidebarPreferencesMenu prefs={createSidebarPreferences(undefined, true)} />,
    ),
};

const ResizePreview = () => {
  const [width, setWidth] = useState(270);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div
      style={{
        position: 'relative',
        width: collapsed ? 0 : width,
        height: '100%',
        background: 'var(--blok-item-hover-bg)',
      }}
    >
      <SidebarResize
        width={width}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        onWidth={(next) => {
          setWidth(next);
          setCollapsed(false);
        }}
      />
    </div>
  );
};

export const Resize: Story = {
  name: 'Redimensionnement',
  render: ({ theme }, { abortSignal }) => isolated(theme, abortSignal, <ResizePreview />),
};
