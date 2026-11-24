import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CloudApiError, mountCloudGateway } from '../../desktop/src/cloud';
import type { CloudInstance, CloudWorkspace } from '../../desktop/src/cloud';
import { PreviewClient, shellPreview } from './shell-story-fixtures';
import type { ShellTheme } from './shell-story-fixtures';

type Args = { theme: ShellTheme };

function welcome(theme: ShellTheme, setup: boolean, password: boolean): HTMLElement {
  const host = shellPreview(theme);
  const workspace: CloudWorkspace = { id: 'atelier', slug: 'atelier', name: 'Atelier', role: 'admin' };
  const instance: CloudInstance = {
    name: 'Blok', setupRequired: setup, passwordAuthAvailable: password, emailCodeAvailable: true,
    signupPolicy: 'invite', workspaceCreation: 'admins_only', defaultWorkspace: setup ? null : workspace,
  };
  const client = new PreviewClient((path, init) => {
    switch (path) {
      case '/api/instance': return instance;
      case '/api/session': throw new CloudApiError(401, 'Connexion requise');
      case '/api/setup/claim': {
        const claim = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { workspace: { name: string; slug: string } };
        Object.assign(workspace, claim.workspace);
        instance.setupRequired = false;
        instance.defaultWorkspace = workspace;
        return { ok: true };
      }
      case '/api/setup/email-test':
      case '/api/auth/request-code': return { ok: true };
      case '/api/auth/password':
      case '/api/auth/verify-code': {
        const { email } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { email: string };
        return { user: { id: 'camille', email }, workspaces: [workspace] };
      }
      default: throw new Error(`Route hors de cet aperçu : ${path}`);
    }
  });
  void mountCloudGateway(host, {
    client,
    onOpenWorkspace(opened) {
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      status.textContent = `Espace « ${opened.name} » ouvert.`;
      host.replaceChildren(status);
    },
  });
  return host;
}

const meta = {
  title: 'Shell/Accueil',
  id: 'shell-accueil',
  parameters: { layout: 'fullscreen' },
  args: { theme: 'light' },
  argTypes: { theme: { name: 'Thème', control: 'inline-radio', options: ['light', 'dark'] } },
  beforeEach() {
    const title = document.title;
    return () => { document.title = title; };
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const CreationMotDePasse: Story = {
  name: 'Créer un espace · mot de passe',
  render: ({ theme }) => welcome(theme, true, true),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Créer votre espace' })).toBeVisible();
    await expect(canvas.getByLabelText('Nom de l’espace')).toBeRequired();
    await expect(canvas.getByLabelText('Mot de passe')).toHaveAttribute('autocomplete', 'new-password');
  },
};

export const CreationParEmail: Story = {
  name: 'Créer un espace · e-mail',
  render: ({ theme }) => welcome(theme, true, false),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Créer votre espace' })).toBeVisible();
    await expect(canvas.queryByLabelText('Mot de passe')).toBeNull();
    await expect(canvas.getByLabelText('Adresse e-mail')).toHaveAccessibleDescription(/code de connexion/);
  },
};

export const Connexion: Story = {
  name: 'Se connecter',
  render: ({ theme }) => welcome(theme, false, true),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText('Mot de passe')).toHaveAttribute('autocomplete', 'current-password');
    await userEvent.click(canvas.getByRole('button', { name: 'Utiliser un code par e-mail' }));
    await expect(canvas.getByRole('button', { name: 'Continuer par e-mail' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Utiliser un mot de passe' }));
    await expect(canvas.getByLabelText('Mot de passe')).toBeVisible();
  },
};

export const VerificationDuCode: Story = {
  name: 'Vérifier le code',
  render: ({ theme }) => welcome(theme, false, false),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Adresse e-mail'), 'camille@example.test');
    await userEvent.click(canvas.getByRole('button', { name: 'Continuer par e-mail' }));
    await expect(await canvas.findByLabelText('Code de connexion')).toHaveAttribute('autocomplete', 'one-time-code');
  },
};
