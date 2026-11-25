import type { CloudClient } from './cloud/client';
import { styleTextField } from './ui/controls';
import { button, el } from './ui/dom';
import { createEmptyState } from './ui/empty-state';
import './mcp-settings.css';

interface McpToken { id: string; label: string; expiresAt: string; lastUsedAt: string | null }
interface IssuedToken { id: string; token: string }
const tokensPath = '/api/mcp/tokens';
const formatDate = (date: string): string => new Date(date).toLocaleDateString('fr-FR');

export function mountMcpSettings(content: HTMLElement, client: CloudClient, options: {embedded?: boolean} = {}): void {
  const panel = el('section', { attribute: 'data-desktop-mcp-panel' });
  const heading = el(options.embedded ? 'h2' : 'h1', {
    attribute: options.embedded ? 'data-desktop-settings-section' : 'data-desktop-settings-title', text: 'Accès MCP',
  });
  const help = el('p', {
    attribute: 'data-desktop-settings-intro',
    text: 'Connectez Codex ou un autre client MCP à vos espaces avec vos propres droits. Chaque jeton expire après 90 jours.',
  });
  const status = el('p', { attribute: 'data-desktop-mcp-status', attrs: { role: 'status' } });
  const endpoint = el('div', { attribute: 'data-desktop-mcp-endpoint' });
  const address = (client.origin || location.origin) + '/mcp';
  const url = el('code', { text: address });
  endpoint.append(el('span', { text: 'Adresse du serveur' }), url, copyButton('Copier l’URL', url, 'Adresse copiée.'));

  const name = el('input', { attribute: 'data-desktop-mcp-name', attrs: {
    type: 'text', maxlength: '80', placeholder: 'Nom du client (ex. Codex)', 'aria-label': 'Nom du jeton MCP',
  } });
  styleTextField(name);
  const form = el('form', { attribute: 'data-desktop-mcp-create' });
  const create = el('button', {
    text: 'Créer un jeton', className: 'blok-button', attribute: 'data-desktop-mcp-primary',
    attrs: { type: 'submit', 'data-desktop-settings-copy': '' },
  });
  form.append(el('label', { text: 'Nom du client', children: [name] }), create);

  const secret = el('div', { attribute: 'data-desktop-mcp-secret' });
  secret.hidden = true;
  let displayedId: string | undefined;
  const listHeading = el(options.embedded ? 'h3' : 'h2', { text: 'Jetons d’accès', attribute: 'data-desktop-mcp-list-heading' });
  const list = el('div', { attribute: 'data-desktop-mcp-list' });
  let revision = 0;
  let busy = false;

  function copyButton(label: string, value: HTMLElement, success: string): HTMLButtonElement {
    return button({
      label, attribute: 'data-desktop-settings-copy',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(value.textContent ?? '');
          if (value.isConnected) status.textContent = success;
        } catch {
          if (!value.isConnected) return;
          const selection = window.getSelection();
          if (selection) {
            const range = document.createRange();
            range.selectNodeContents(value);
            selection.removeAllRanges();
            selection.addRange(range);
          }
          status.textContent = 'Copie automatique indisponible. Vous pouvez copier le texte sélectionné.';
        }
      },
    });
  }

  function hideSecret(): void {
    displayedId = undefined;
    secret.hidden = true;
    secret.replaceChildren();
  }

  function showSecret(issued: IssuedToken): void {
    displayedId = issued.id;
    const value = el('code', { attribute: 'data-desktop-settings-path', text: issued.token });
    const copy = copyButton('Copier le jeton', value, 'Jeton copié.');
    const hide = button({ label: 'Masquer le jeton', attribute: 'data-desktop-settings-copy', onClick: () => {
      hideSecret();
      name.focus();
    } });
    secret.replaceChildren(
      el('p', { text: 'Copiez ce jeton maintenant. Il sera uniquement visible dans ce panneau.' }),
      value, el('div', { attribute: 'data-desktop-mcp-secret-actions', children: [copy, hide] }),
    );
    secret.hidden = false;
    copy.focus();
  }

  function setBusy(value: boolean): void {
    busy = value;
    create.disabled = value;
    name.readOnly = value;
    for (const control of list.querySelectorAll('button')) control.disabled = value;
  }

  async function mutate(operation: () => Promise<void>, failure: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      if (panel.isConnected) await refresh();
    } catch {
      if (panel.isConnected) status.textContent = failure;
    } finally {
      setBusy(false);
    }
  }

  function tokenRow(token: McpToken): HTMLElement {
    const path = tokensPath + '/' + encodeURIComponent(token.id);
    const text = el('div', { attribute: 'data-desktop-mcp-token-info', children: [
      el('strong', { text: token.label }),
      el('span', { text: token.lastUsedAt ? 'Dernière utilisation le ' + formatDate(token.lastUsedAt) : 'Jamais utilisé' }),
      el('span', { text: 'Expire le ' + formatDate(token.expiresAt) }),
    ] });
    const rotate = button({ label: 'Renouveler', attribute: 'data-desktop-settings-copy', onClick: () => mutate(async () => {
      const issued = await client.request<IssuedToken>(path + '/rotate', { method: 'POST' });
      if (!panel.isConnected) return;
      showSecret(issued);
      status.textContent = 'Ancien jeton désactivé. Copiez le nouveau.';
    }, 'Impossible de renouveler ce jeton.') });
    const revoke = button({ label: 'Révoquer', attribute: 'data-desktop-settings-copy', onClick: () => mutate(async () => {
      await client.request(path, { method: 'DELETE' });
      if (!panel.isConnected) return;
      if (displayedId === token.id) hideSecret();
      status.textContent = 'Jeton révoqué.';
      name.focus();
    }, 'Impossible de révoquer ce jeton.') });
    revoke.setAttribute('data-desktop-mcp-revoke', '');
    return el('div', { attribute: 'data-desktop-mcp-token', children: [
      text, el('span', { attribute: 'data-desktop-mcp-actions', children: [rotate, revoke] }),
    ] });
  }

  async function refresh(): Promise<void> {
    const current = ++revision;
    list.setAttribute('aria-busy', 'true');
    try {
      const { tokens } = await client.request<{tokens: McpToken[]}>(tokensPath);
      if (!panel.isConnected || revision !== current) return;
      if (tokens.length) {
        list.replaceChildren(...tokens.map(tokenRow));
      } else {
        list.replaceChildren(createEmptyState({
          attribute: 'data-desktop-mcp-empty', title: 'Aucun jeton actif',
          description: 'Créez un jeton pour connecter votre premier client MCP.',
        }));
      }
    } catch {
      if (!panel.isConnected || revision !== current) return;
      const retry = button({ label: 'Réessayer', attribute: 'data-desktop-settings-copy', onClick: refresh });
      list.replaceChildren(createEmptyState({
        attribute: 'data-desktop-mcp-empty', title: 'Impossible de charger les jetons MCP.', action: retry,
      }));
    } finally {
      if (revision === current) list.removeAttribute('aria-busy');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const label = name.value.trim();
    if (!label || new TextEncoder().encode(label).length > 80) {
      status.textContent = label ? 'Le nom du client est trop long.' : 'Donnez un nom au jeton.';
      name.focus();
      return;
    }
    void mutate(async () => {
      const issued = await client.request<IssuedToken>(tokensPath, { method: 'POST', body: JSON.stringify({ label }) });
      if (!panel.isConnected) return;
      name.value = '';
      showSecret(issued);
      status.textContent = 'Jeton créé.';
    }, 'Impossible de créer le jeton.');
  });
  list.textContent = 'Chargement des jetons…';
  panel.append(heading, help, endpoint, form, status, secret, listHeading, list);
  content.append(panel);
  void refresh();
}
