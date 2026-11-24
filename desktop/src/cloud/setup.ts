import { button, el, field } from '../ui/dom';
import type { CloudClient } from './client';

/** Build the URL identifier used when creating a workspace. */
export function deriveWorkspaceSlug(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  if (!base) return 'espace';
  if (base.length === 1) return `${base}0`;
  return base;
}

export interface SetupAssistantOptions {
  client: CloudClient;
  onClaimed(email: string): void;
  frame(): HTMLElement;
  run(action: () => Promise<void>): Promise<void>;
}

export function mountSetupAssistant(options: SetupAssistantOptions): void {
  const main = options.frame();
  main.setAttribute('data-cloud-narrow', '');
  const form = el('form', { attribute: 'data-cloud-stack' });
  const workspace = field({ form, label: 'Nom de l’espace', type: 'text', name: 'workspace-name' });
  workspace.maxLength = 120;
  workspace.autocomplete = 'organization';
  const admin = field({ form, label: 'Votre nom', type: 'text', name: 'admin-name' });
  admin.maxLength = 120;
  admin.autocomplete = 'name';
  const email = field({ form, label: 'Adresse e-mail', type: 'email', name: 'admin-email' });
  email.autocomplete = 'email';

  const hint = el('small', { text: 'Vous recevrez un code de connexion à cette adresse.', attrs: { id: 'setup-email-hint' } });
  email.setAttribute('aria-describedby', hint.id);
  const submit = button({ label: 'Créer l’espace', primary: true, block: true, type: 'submit', onClick: () => {} });
  form.append(hint, submit);
  for (const input of [workspace, admin]) {
    input.addEventListener('input', () => input.setCustomValidity(''));
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = workspace.value.trim();
    const adminName = admin.value.trim();
    workspace.setCustomValidity(!name ? 'Saisissez un nom pour votre espace.'
      : new TextEncoder().encode(name).length > 120 ? 'Raccourcissez le nom de votre espace.' : '');
    admin.setCustomValidity(adminName ? '' : 'Saisissez votre nom.');
    if (submit.disabled || !form.reportValidity()) return;
    const address = email.value.trim();
    void options.run(async () => {
      await options.client.request('/api/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ workspace: { name, slug: deriveWorkspaceSlug(name) }, name: adminName, email: address }),
      });
      options.onClaimed(address);
    });
  });
  const mailTest = el('details', { attribute: 'data-cloud-section' });
  const status = el('p', { attribute: 'data-cloud-note', attrs: { role: 'status' } });
  status.hidden = true;
  mailTest.append(el('summary', { text: 'Tester l’envoi d’e-mails' }), button({
    label: 'Envoyer un e-mail de test',
    onClick: () => {
      if (!email.reportValidity()) return;
      const address = email.value.trim();
      void options.run(async () => {
        status.hidden = true;
        await options.client.request('/api/setup/email-test', { method: 'POST', body: JSON.stringify({ email: address }) });
        status.textContent = `E-mail de test envoyé à ${address}.`;
        status.hidden = false;
      });
    },
  }), status);
  main.append(el('h1', { text: 'Créer votre espace' }), form, mailTest);
}
