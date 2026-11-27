import type {Meta, StoryObj} from '@storybook/html-vite';
import {expect, fn, userEvent, waitFor, within} from 'storybook/test';
import {examplePages, isolated, themeControl, type PreviewArgs} from './preview';

const meta = {
  title: 'Shell/Top bar TSX/Barre de page',
  id: 'top-bar-tsx',
  parameters: {layout: 'fullscreen'},
  args: {theme: 'dark'},
  argTypes: {theme: themeControl},
} satisfies Meta<PreviewArgs>;
export default meta;
type Story = StoryObj<PreviewArgs>;

export const Trail: Story = {
  name: 'Fil d’Ariane · parent et page courante',
  render: ({theme}, {abortSignal}) => isolated(theme, abortSignal, examplePages(), {
    pageUrl: id => `https://blok.example.com/?page=${id}`,
    favorite: true, onFavorite: fn(),
  }),
  play: async ({canvasElement}) => {
    const ui = within(canvasElement);
    await expect(await ui.findByText('Navigation desktop')).toBeVisible();
    // La page courante se marque, le parent reste cliquable.
    await expect(ui.getByTitle('Projets')).toBeVisible();
  },
};

export const Solo: Story = {
  name: 'Page sans parent · aucun nom d’espace',
  render: ({theme}, {abortSignal}) =>
    isolated(theme, abortSignal, [{id: 'p', title: 'Nouvelle page', icon: '📄'}], {storedOnDevice: true}),
  play: async ({canvasElement}) => {
    const ui = within(canvasElement);
    await expect(ui.queryByText('Espace local')).toBeNull();
    await expect(await ui.findByText('Nouvelle page')).toBeVisible();
  },
};

export const Menu: Story = {
  name: 'Menu de la page · pleine largeur et stockage',
  render: ({theme}, {abortSignal}) => isolated(theme, abortSignal, examplePages(), {
    storedOnDevice: true, onRename: fn(), onDuplicate: fn(), onDelete: fn(),
  }),
  play: async ({canvasElement}) => {
    const ui = within(canvasElement);
    await userEvent.click(await ui.findByRole('button', {name: 'Actions de la page'}));
    const toggle = await ui.findByRole('menuitemcheckbox', {name: 'Pleine largeur'});
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    await expect(ui.getByText('Sur cet appareil')).toBeVisible();
  },
};

export const Pages: Story = {
  name: 'Menu du fil · sous-pages et retour',
  render: ({theme}, {abortSignal}) => isolated(theme, abortSignal, [{
    id: 'child', title: 'Navigation desktop', icon: '🎨', menuHeading: 'Projets', menu: [
      {id: 'child', title: 'Navigation desktop', icon: '🎨', current: true, onOpen: fn(), children: [
        {id: 'spec', title: 'Spécification', icon: '📐', onOpen: fn()},
        {id: 'notes', title: 'Notes de revue', icon: '📝', onOpen: fn()},
      ]},
      {id: 'sibling', title: 'Calendrier', icon: '📅', onOpen: fn()},
    ],
  }]),
  play: async ({canvasElement}) => {
    const ui = within(canvasElement);
    await userEvent.click(await ui.findByTitle('Navigation desktop'));
    await expect(await ui.findByText('Projets')).toBeVisible();
    await userEvent.click(await ui.findByRole('menuitem', {name: 'Sous-pages de Navigation desktop'}));
    await waitFor(() => expect(ui.getByText('Spécification')).toBeVisible());
    await userEvent.click(await ui.findByRole('menuitem', {name: '‹ Retour'}));
    await waitFor(() => expect(ui.getByText('Calendrier')).toBeVisible());
  },
};

export const Peers: Story = {
  name: 'Présences · au-delà de deux lecteurs',
  render: ({theme}, {abortSignal}) => isolated(theme, abortSignal, examplePages(),
    {onHistory: () => () => {}}, toolbar => toolbar.setPeers(['Ana', 'Bo', 'Cy'])),
  play: async ({canvasElement}) => {
    const ui = within(canvasElement);
    await expect(await ui.findByText('Ana, Bo +1')).toBeVisible();
  },
};
