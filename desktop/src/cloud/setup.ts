import {shellText} from '../shell-i18n';
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
  passwordAuthAvailable?: boolean;
  onClaimed(email: string, password?: string): void | Promise<void>;
  frame(): HTMLElement;
  run(action: () => Promise<void>): Promise<void>;
}

export function mountSetupAssistant(options: SetupAssistantOptions): void {
  const main = options.frame();
  main.setAttribute('data-cloud-narrow', '');
  const form = el('form', { attribute: 'data-cloud-stack' });
  const workspace = field({ form, label: shellText("Nom de l’espace"), type: 'text', name: 'workspace-name' });
  workspace.maxLength = 120;
  workspace.autocomplete = 'organization';
  const admin = field({ form, label: shellText("Votre nom"), type: 'text', name: 'admin-name' });
  admin.maxLength = 120;
  admin.autocomplete = 'name';
  const email = field({ form, label: shellText("Adresse e-mail"), type: 'email', name: 'admin-email' });
  email.autocomplete = options.passwordAuthAvailable ? 'username' : 'email';
  const password = options.passwordAuthAvailable
    ? field({ form, label: shellText("Mot de passe"), type: 'password', name: 'admin-password' })
    : null;
  if (password) {
    password.autocomplete = 'new-password';
    password.minLength = 12;
    password.maxLength = 1024;
    password.addEventListener('input', () => password.setCustomValidity(''));
  }

  const hint = el('small', {
    text: password ? shellText("12 caractères minimum.") : shellText("Vous recevrez un code de connexion à cette adresse."),
    attrs: { id: 'setup-credential-hint' },
  });
  (password ?? email).setAttribute('aria-describedby', hint.id);
  const submit = button({ label: shellText("Créer l’espace"), primary: true, block: true, type: 'submit', onClick: () => {} });
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
    if (password) {
      const value = password.value;
      const withinLimits = [...value].length >= 12 && new TextEncoder().encode(value).length <= 1024;
      password.setCustomValidity(withinLimits ? '' : 'Utilisez au moins 12 caractères et au plus 1 024 octets.');
    }
    if (submit.disabled || !form.reportValidity()) return;
    const address = email.value.trim();
    const secret = password?.value;
    void options.run(async () => {
      await options.client.request('/api/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ workspace: { name, slug: deriveWorkspaceSlug(name) }, name: adminName, email: address, password: secret }),
      });
      await options.onClaimed(address, secret);
    });
  });
  main.append(el('h1', { text: shellText("Créer votre espace") }), form);
  if (password) return;

  const mailTest = el('details', { attribute: 'data-cloud-section' });
  const status = el('p', { attribute: 'data-cloud-note', attrs: { role: 'status' } });
  status.hidden = true;
  mailTest.append(el('summary', { text: shellText("Tester l’envoi d’e-mails") }), button({
    label: shellText("Envoyer un e-mail de test"),
    onClick: () => {
      if (!email.reportValidity()) return;
      const address = email.value.trim();
      void options.run(async () => {
        status.hidden = true;
        await options.client.request('/api/setup/email-test', { method: 'POST', body: JSON.stringify({ email: address }) });
        status.textContent = shellText("E-mail de test envoyé à {v0}.", {v0: address});
        status.hidden = false;
      });
    },
  }), status);
  main.append(mailTest);
}
