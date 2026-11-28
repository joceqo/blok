import type { Meta, StoryObj } from '@storybook/html-vite';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CalendarPortalHost } from '../../portal';
import '../../theme.css';
import { Button } from './button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu';

type PreviewProps = { theme: 'light' | 'dark' };

const meta = {
  title: 'Design system/Calendrier',
  args: { theme: 'light' },
  argTypes: { theme: { control: 'radio', options: ['light', 'dark'] } },
} satisfies Meta<PreviewProps>;
export default meta;
type Story = StoryObj<PreviewProps>;

const CalendarViewMenu = () => {
  const [view, setView] = useState('Semaine');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="secondary" />}>{view}</DropdownMenuTrigger>
      <DropdownMenuContent sideOffset={8}>
        {['Jour', 'Semaine', 'Mois'].map((label) => (
          <DropdownMenuItem key={label} onClick={() => setView(label)}>{label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const Menu: Story = {
  render: ({ theme }, { abortSignal }) => {
    const host = document.createElement('div');
    host.classList.add('blok-calendarcn', theme);
    Object.assign(host.style, {
      display: 'grid', placeContent: 'center', minHeight: '65vh',
      background: 'var(--background)', color: 'var(--foreground)',
    });
    const mount = document.createElement('div');
    host.append(mount);
    const root = createRoot(mount);
    root.render(<CalendarPortalHost.Provider value={host}><CalendarViewMenu /></CalendarPortalHost.Provider>);
    abortSignal.addEventListener('abort', () => root.unmount(), { once: true });
    return host;
  },
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    const trigger = await ui.findByRole('button', { name: 'Semaine' });
    await userEvent.click(trigger);
    await userEvent.click(await ui.findByRole('menuitem', { name: 'Mois' }));
    await expect(trigger).toHaveAccessibleName('Mois');
  },
};
