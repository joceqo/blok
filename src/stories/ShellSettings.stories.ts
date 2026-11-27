import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, within } from 'storybook/test';
import { createPageFrame } from '../shell/sidebar';
import { createDesktopFooter } from '../../desktop/src/settings';
import { shellPreview, type ShellTheme } from './shell-story-fixtures';
import '../shell/sidebar.css';

type Args = { theme: ShellTheme };

function settings(theme: ShellTheme, signal: AbortSignal, panel: 'preferences' | 'account' = 'preferences') {
  const host = shellPreview(theme);
  const frame = createPageFrame({pages: [], activeId: '', onOpen() {}, onCreate() {}});
  const footer = createDesktopFooter(() => {}, {kind: 'local', id: 'atelier', name: 'Atelier'}, frame.headerActions, {sidebarPreferences: frame.sidebarPreferences, signal});
  const sidebar = frame.element.querySelector<HTMLElement>('[data-blok-sidebar]')!;
  sidebar.insertBefore(footer, sidebar.querySelector('[data-blok-sidebar-edge]'));
  host.append(frame.element);
  queueMicrotask(() => {
    if (signal.aborted) return;
    footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]')?.click();
    const target = panel === 'account' ? '[data-desktop-menu-account]' : '[data-desktop-menu-preferences]';
    footer.querySelector<HTMLButtonElement>(target)?.click();
  });
  return host;
}

const meta = {
  title: 'Shell/Paramètres', id: 'shell-parametres',
  parameters: {layout: 'fullscreen'}, args: {theme: 'dark'},
  argTypes: {theme: {name: 'Thème', control: 'inline-radio', options: ['light', 'dark']}},
} satisfies Meta<Args>;
export default meta;

export const Preferences: StoryObj<Args> = {
  name: 'Préférences',
  render: ({theme}, {abortSignal}) => settings(theme, abortSignal),
  play: async ({canvasElement}) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = within(await page.findByRole('dialog', {name:'Paramètres'}));
    await expect(dialog.getByRole('heading', {name:'Préférences'})).toBeVisible();
    await expect(dialog.getByRole('button', {name:'Thème'})).toBeEnabled();
  },
};

export const ProfilLocal: StoryObj<Args> = {
  name: 'Profil local sur disque',
  render: ({theme}, {abortSignal}) => settings(theme, abortSignal, 'account'),
  play: async ({canvasElement}) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = within(await page.findByRole('dialog', {name:'Paramètres'}));
    await expect(dialog.getByRole('heading', {name:'Profil local'})).toBeVisible();
    await expect(dialog.getByRole('textbox', {name:'Nom du profil local'})).toBeEnabled();
    await expect(dialog.queryByLabelText('Adresse e-mail')).toBeNull();
  },
};

export const RechercheDetaillee: StoryObj<Args> = {
  name: 'Recherche d’un réglage',
  render: ({theme}, {abortSignal}) => settings(theme, abortSignal),
  play: async ({canvasElement}) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = within(await page.findByRole('dialog', {name: 'Paramètres'}));
    if (!dialog.queryByRole('searchbox')) {
      await userEvent.click(dialog.getByRole('button', {name: 'Rubriques'}));
    }
    const search = dialog.getByRole('searchbox', {name: 'Rechercher dans les réglages'});
    await userEvent.type(search, 'favoris');
    await expect(dialog.getByRole('button', {name: /^Favoris/})).toBeVisible();
  },
};
