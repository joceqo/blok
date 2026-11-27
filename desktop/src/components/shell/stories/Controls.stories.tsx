import type { Meta, StoryObj } from '@storybook/html-vite';
import { ArrowUpRight, ChevronDown, Plus, Settings, UserRoundPlus } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { shellPreview, type ShellTheme } from '../../../../../src/stories/shell-story-fixtures';
import {
  SuggestionCard,
  Avatar,
  Button,
  Choice,
  EmptyState,
  Feedback,
  TextField,
  SearchField,
  SwitchRow,
  SectionHeader as ShellSectionHeader,
  SectionAction,
  Tooltip as ShellTooltip,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../index';

interface PreviewProps {
  theme: ShellTheme;
  side: 'top' | 'bottom' | 'left' | 'right';
  sideOffset: number;
}

const meta = {
  title: 'Design system/Shell',
  args: { theme: 'light', side: 'bottom', sideOffset: 8 },
  argTypes: {
    theme: { control: 'radio', options: ['light', 'dark'] },
    side: { control: 'select', options: ['top', 'bottom', 'left', 'right'] },
    sideOffset: { control: { type: 'range', min: 0, max: 24 } },
  },
} satisfies Meta<PreviewProps>;
export default meta;
type Story = StoryObj<PreviewProps>;

function preview(
  theme: ShellTheme,
  signal: AbortSignal,
  content: (host: HTMLElement) => ReactNode,
) {
  const host = shellPreview(theme);
  host.style.display = 'grid';
  host.style.placeContent = 'center';
  const mount = document.createElement('div');
  host.append(mount);
  const root = createRoot(mount);
  root.render(content(host));
  signal.addEventListener('abort', () => root.unmount(), { once: true });
  return host;
}

export const Buttons: Story = {
  name: 'Boutons',
  parameters: { controls: { include: ['theme'] } },
  render: ({ theme }, { abortSignal }) =>
    preview(theme, abortSignal, () => (
      <div style={{ display: 'flex', gap: 8 }}>
        <Button>Ajouter</Button>
        <Button variant="ghost">Annuler</Button>
        <Button disabled>Indisponible</Button>
      </div>
    )),
};

const ExampleMenu = ({
  host,
  side,
  sideOffset,
}: Pick<PreviewProps, 'side' | 'sideOffset'> & { host: HTMLElement }) => {
  const [view, setView] = useState('Pages');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button />}>
        {view}
        <ChevronDown size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={host}
        side={side}
        sideOffset={sideOffset}
        aria-label="Vues"
      >
        <DropdownMenuItem onClick={() => setView('Pages')}>Pages</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setView('Paramètres')}>
          <Settings size={16} />
          Paramètres
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const Menu: Story = {
  render: ({ theme, side, sideOffset }, { abortSignal }) =>
    preview(theme, abortSignal, (host) => (
      <ExampleMenu
        host={host}
        side={side}
        sideOffset={sideOffset}
      />
    )),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    const trigger = await ui.findByRole('button', { name: 'Pages' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    const item = await ui.findByRole('menuitem', { name: 'Paramètres' });
    const firstItem = ui.getByRole('menuitem', { name: 'Pages' });
    await waitFor(() => expect(firstItem).toHaveFocus());
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(item).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await expect(trigger).toHaveAccessibleName('Paramètres');
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

const formats = [
  { value: 'compact', label: 'Compact' },
  { value: 'normal', label: 'Normal' },
] as const;

const FormExample = () => {
  const nameId = useId();
  const [format, setFormat] = useState<'compact' | 'normal'>('normal');
  const [checked, setChecked] = useState(true);
  return (
    <div style={{ display: 'grid', gap: 12, width: 280 }}>
      <label htmlFor={nameId}>
        Nom de l’espace
        <TextField
          id={nameId}
          defaultValue="Studio"
        />
      </label>
      <SearchField
        aria-label="Rechercher une page"
        placeholder="Rechercher une page…"
      />
      <Choice<typeof format>
        label="Densité"
        value={format}
        options={formats}
        onChange={setFormat}
      />
      <SwitchRow
        label="Favoris"
        help="Afficher les pages favorites dans la sidebar."
        checked={checked}
        onChange={setChecked}
      />
    </div>
  );
};

export const Fields: Story = {
  name: 'Champs, sélecteur et interrupteur',
  parameters: { controls: { include: ['theme'] } },
  render: ({ theme }, { abortSignal }) => preview(theme, abortSignal, () => <FormExample />),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    const toggle = await ui.findByRole('switch', { name: 'Favoris' });
    await userEvent.click(toggle);
    await expect(toggle).not.toBeChecked();
    const search = ui.getByRole('searchbox');
    await userEvent.type(search, 'Projet');
    await expect(search).toHaveValue('Projet');
  },
};

export const States: Story = {
  name: 'Avatar, état vide et retours',
  parameters: { controls: { include: ['theme'] } },
  render: ({ theme }, { abortSignal }) =>
    preview(theme, abortSignal, () => (
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Avatar
            name="Studio"
            data-desktop-avatar=""
          />
          Studio
        </div>
        <EmptyState description="Les pages ajoutées aux favoris apparaîtront ici.">
          Aucun favori
        </EmptyState>
        <Feedback>Modifications enregistrées</Feedback>
        <Feedback kind="error">Impossible d’enregistrer les modifications.</Feedback>
      </div>
    )),
};

export const Tooltip: Story = {
  name: 'Infobulle',
  args: { theme: 'dark', sideOffset: 6 },
  render: ({ theme, side, sideOffset }, { abortSignal }) =>
    preview(theme, abortSignal, () => (
      <ShellTooltip
        label="Ouvrir dans la bibliothèque"
        side={side}
        sideOffset={sideOffset}
      >
        <Button aria-label="Bibliothèque">
          <ArrowUpRight size={16} />
        </Button>
      </ShellTooltip>
    )),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    const button = await ui.findByRole('button', { name: 'Bibliothèque' });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await expect(await ui.findByRole('tooltip')).toHaveTextContent('Ouvrir dans la bibliothèque');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(ui.queryByRole('tooltip')).toBeNull());
    await userEvent.hover(button);
    await waitFor(() => expect(ui.getByRole('tooltip')).toBeVisible());
  },
};

const SectionExample = () => {
  const [expanded, setExpanded] = useState(true);
  const [pages, setPages] = useState([{ id: 'journal', title: 'Journal' }]);
  return (
    <div style={{ width: 254 }}>
      <ShellSectionHeader
        label="Privé"
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      >
        <SectionAction
          label="Ajouter une page"
          onClick={() => {
            setPages([...pages, { id: crypto.randomUUID(), title: 'Nouvelle page' }]);
            setExpanded(true);
          }}
        >
          <Plus size={16} />
        </SectionAction>
      </ShellSectionHeader>
      {expanded && (
        <ul>
          {pages.map((page) => (
            <li key={page.id}>{page.title}</li>
          ))}
        </ul>
      )}
    </div>
  );
};
export const SectionHeader: Story = {
  name: 'En-tête de section',
  args: { theme: 'dark' },
  parameters: { controls: { include: ['theme'] } },
  render: ({ theme }, { abortSignal }) => preview(theme, abortSignal, () => <SectionExample />),
  play: async ({ canvasElement }) => {
    const ui = within(canvasElement);
    const toggle = await ui.findByRole('button', { name: 'Privé' });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const add = ui.getByRole('button', { name: 'Ajouter une page' });
    await userEvent.click(add);
    await expect(ui.getByText('Nouvelle page')).toBeVisible();
    await userEvent.hover(add);
    await expect(await ui.findByRole('tooltip')).toHaveTextContent('Ajouter une page');
  },
};

const SuggestionExample = () => {
  const [visible, setVisible] = useState(true);
  const [opened, setOpened] = useState(false);
  if (!visible || opened)
    return (
      <Button
        onClick={() => {
          setVisible(true);
          setOpened(false);
        }}
      >
        Réafficher la carte
      </Button>
    );
  return (
    <div style={{ width: 240 }}>
      <SuggestionCard
        title="Inviter des membres"
        description="Collaborez avec votre équipe."
        icon={<UserRoundPlus size={17} />}
        onSelect={() => setOpened(true)}
        onDismiss={() => setVisible(false)}
      />
    </div>
  );
};
export const Suggestion: Story = {
  name: 'Carte de suggestion',
  args: { theme: 'dark' },
  parameters: { controls: { include: ['theme'] } },
  render: ({ theme }, { abortSignal }) => preview(theme, abortSignal, () => <SuggestionExample />),
};
