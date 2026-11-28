import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, within } from 'storybook/test';
import { openPageSearch } from '../../desktop/src/page-search';
import '../../desktop/src/navigation-dialogs.css';
import { shellPreview, type ShellTheme } from './shell-story-fixtures';

const pages = [
  { id: 'atelier', title: 'Atelier', parentId: null, icon: '🗂️', cover: 'dusk', text: 'Décisions et documents de l’équipe produit.' },
  { id: 'brief', title: 'Brief produit', parentId: 'atelier', icon: '📒', text: 'Préparer les entretiens avec les équipes de terrain.' },
  { id: 'planning', title: 'Planning', parentId: 'atelier', icon: '🗓️', text: 'Le lancement est prévu après la revue de conception.' },
];

const meta = {
  title: 'Shell/Recherche',
  id: 'shell-recherche',
  parameters: { layout: 'fullscreen' },
  args: { theme: 'dark' },
  argTypes: { theme: { name: 'Thème', control: 'inline-radio', options: ['light', 'dark'] } },
  render: ({theme}, {abortSignal, viewMode}) => {
    const host = shellPreview(theme);
    const launcher = document.createElement('button');
    launcher.className = 'blok-button';
    launcher.type = 'button';
    launcher.textContent = 'Rechercher dans Atelier';
    const heading = document.createElement('h1');
    heading.textContent = pages[0].title;
    const open = (id: string) => { heading.textContent = pages.find(page => page.id === id)?.title ?? 'Revue du projet'; };
    let close: (() => void) | undefined;
    launcher.onclick = () => {
      close?.();
      close = openPageSearch({
        workspaceName: 'Atelier', pages: () => pages, recentIds: ['brief', 'atelier'],
        visitedAt: id => id === 'brief' ? Date.now() : Date.now() - 86400000,
        onOpen: open, onOpenTab: open,
        preview: async id => pages.find(page => page.id === id)?.text ?? '',
        searchContent: async query => pages.filter(page => page.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .map(page => ({id: page.id, excerpt: page.text})),
        chats: () => [{id:'revue', title:'Revue du projet', excerpt:'Décisions de la semaine.'}], onOpenChat: open,
      });
    };
    host.append(launcher, heading);
    if (viewMode === 'story') queueMicrotask(() => { if (!abortSignal.aborted && launcher.isConnected) launcher.click(); });
    abortSignal.addEventListener('abort', () => close?.(), {once:true});
    return host;
  },
} satisfies Meta<{theme: ShellTheme}>;
export default meta;
type Story = StoryObj<{theme:ShellTheme}>;

export const Palette: Story = {
  play: async ({canvasElement, viewMode}) => {
    if (viewMode !== 'story') return;
    const screen = within(canvasElement.ownerDocument.body);
    const field = await screen.findByRole('combobox', {name:'Rechercher dans Atelier'});
    await expect(field).toHaveFocus();
    await expect(screen.getByRole('group', {name:'Aujourd’hui'})).toBeVisible();
    await expect(screen.getByRole('option', {name:/Brief produit/})).toHaveAttribute('aria-selected', 'true');
  },
};
export const DansLeContenu: Story = {
  name: 'Correspondance dans le contenu',
  play: async ({canvasElement, viewMode}) => {
    if (viewMode !== 'story') return;
    const screen = within(canvasElement.ownerDocument.body);
    const field = await screen.findByRole('combobox', {name:'Rechercher dans Atelier'});
    await userEvent.type(field, 'lancement');
    const result = await screen.findByRole('option', {name:/Planning/});
    await expect(within(result).getByText('lancement', {selector:'mark'})).toBeVisible();
  },
};
