import mcpPackage from '../../packages/mcp/package.json';
import { dataDirectory } from './storage';
import type { LocalWorkspace } from './workspace-registry';
import { pageIdForHref, libraryCategoryForHref } from './page-urls';
import { CloudClient } from './cloud/client';
import { styleTextField } from './ui/controls';
import './mcp-settings.css';

interface McpToken { id: string; label: string; createdAt: string; expiresAt: string; lastUsedAt: string | null }

const LIFETIMES: [string, string][] = [['1d','1 jour'],['7d','7 jours'],['30d','30 jours'],['90d','90 jours'],['1y','1 an'],['never','N’expire pas']];
/** The service gives a non-expiring token a far sentinel; past this, say so rather than print the year. */
const NEVER_AFTER_YEARS = 50;
function expiryText(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return 'Expiration inconnue';
  return date.getTime() - Date.now() > NEVER_AFTER_YEARS * 365 * 24 * 3600 * 1000
    ? 'N’expire pas'
    : `Expire le ${date.toLocaleDateString('fr-FR')}`;
}

export async function mountLocalMcpSettings(content: HTMLElement, workspace: LocalWorkspace): Promise<void> {
  const panel = document.createElement('section');
  panel.setAttribute('data-desktop-mcp-panel', '');
  const heading = document.createElement('h1');
  heading.setAttribute('data-desktop-settings-title', ''); heading.textContent = 'Accès MCP';
  const help = document.createElement('p');
  help.setAttribute('data-desktop-settings-intro', '');
  panel.append(heading, help); content.append(panel);
  if (!('__TAURI_INTERNALS__' in window)) {
    help.textContent = 'Cet espace est enregistré dans le navigateur. Le MCP local utilise les fichiers des espaces créés dans l’application Blok pour ordinateur.';
    return;
  }
  help.textContent = 'L’IA accède aux fichiers de cet espace sur votre ordinateur, sans jeton. Copiez les instructions dans votre assistant local. Node.js 20.19 ou ultérieur est requis.';
  const status = document.createElement('p');
  status.setAttribute('role', 'status'); status.setAttribute('data-desktop-mcp-status', '');
  status.textContent = 'Recherche du dossier de cet espace…'; panel.append(status);
  try {
    const directory = await dataDirectory(workspace);
    if (!panel.isConnected) return;
    const server = `blok-local-${workspace.id}`;
    const config = { mcpServers: { [server]: {
      command: 'npx', args: ['--yes', `@bloklabs/mcp@${mcpPackage.version}`, '--source', `files:${directory}`],
    } } };
    const pageId = libraryCategoryForHref(location.href) ? null : pageIdForHref(location.href);
    const text = [
      'Utilise ce serveur MCP local en mode stdio pour accéder à mon espace Blok.',
      JSON.stringify(config, null, 2),
      ...(pageId && /^[a-zA-Z0-9-]+$/.test(pageId) ? [`Page ouverte dans Blok · documentId = ${pageId}`] : []),
    ].join('\n\n');
    const instructions = document.createElement('div');
    instructions.setAttribute('data-desktop-mcp-endpoint', '');
    const label = document.createElement('span'); label.textContent = workspace.name;
    const code = document.createElement('code'); code.textContent = text;
    code.setAttribute('data-desktop-mcp-instructions', '');
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'blok-button'; copy.setAttribute('data-desktop-settings-copy', '');
    copy.textContent = 'Copier pour l’IA';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = 'Instructions copiées.';
      } catch { status.textContent = 'Sélectionnez les instructions ci-dessus pour les copier.'; }
    });
    instructions.append(label, code, copy); panel.insertBefore(instructions, status);
    status.textContent = '';
  } catch { status.textContent = 'Impossible de lire le chemin de cet espace local.'; }
}

export function mountMcpSettings(content: HTMLElement, client: CloudClient, options: {embedded?: boolean} = {}): void {
  const panel = document.createElement('section'); panel.setAttribute('data-desktop-mcp-panel', '');
  const heading = document.createElement(options.embedded ? 'h2' : 'h1'); heading.setAttribute(options.embedded ? 'data-desktop-settings-section' : 'data-desktop-settings-title', ''); heading.textContent = 'Accès MCP';
  const help = document.createElement('p'); help.setAttribute('data-desktop-settings-intro', '');
  help.textContent = 'Connectez Codex ou un autre client MCP à vos espaces avec vos propres droits. Le jeton est affiché une seule fois ; vous choisissez sa durée de validité.';
  const endpoint = document.createElement('div'); endpoint.setAttribute('data-desktop-mcp-endpoint', '');
  const endpointLabel = document.createElement('span'); endpointLabel.textContent = 'Adresse du serveur';
  const url = document.createElement('code'); url.textContent = `${client.origin}/mcp`;
  const copyUrl = document.createElement('button'); copyUrl.type = 'button'; copyUrl.className = 'blok-button'; copyUrl.setAttribute('data-desktop-settings-copy', ''); copyUrl.textContent = 'Copier l’URL';
  copyUrl.addEventListener('click', () => { void navigator.clipboard.writeText(url.textContent ?? '').then(() => { copyUrl.textContent = 'Copié'; }).catch(() => { status.textContent = 'Impossible de copier l’adresse du serveur.'; }); });
  endpoint.append(endpointLabel, url, copyUrl);
  const name = document.createElement('input'); name.setAttribute('data-desktop-mcp-name', ''); name.type = 'text'; name.maxLength = 80; name.placeholder = 'Nom du client (ex. Codex)'; name.setAttribute('aria-label', 'Nom du jeton MCP'); styleTextField(name);
  const form = document.createElement('form'); form.setAttribute('data-desktop-mcp-create', '');
  const lifetime = document.createElement('select'); lifetime.setAttribute('data-desktop-mcp-lifetime', ''); lifetime.setAttribute('aria-label', 'Durée de validité du jeton');
  for (const [value, text] of LIFETIMES) { const option = document.createElement('option'); option.value = value; option.textContent = text; lifetime.append(option); }
  lifetime.value = '90d';
  const lifetimeLabel = document.createElement('label'); lifetimeLabel.textContent = 'Durée de validité'; lifetimeLabel.append(lifetime);
  const nameLabel = document.createElement('label'); nameLabel.textContent = 'Nom du client'; nameLabel.append(name);
  const create = document.createElement('button'); create.type = 'submit'; create.className = 'blok-button'; create.setAttribute('data-desktop-mcp-primary', ''); create.setAttribute('data-desktop-settings-copy', ''); create.textContent = 'Créer un jeton';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('data-desktop-mcp-status', '');
  const secret = document.createElement('div'); secret.setAttribute('data-desktop-mcp-secret', ''); secret.hidden = true;
  const listHeading = document.createElement('h2'); listHeading.textContent = 'Jetons d’accès'; listHeading.setAttribute('data-desktop-mcp-list-heading', '');
  const list = document.createElement('div'); list.setAttribute('data-desktop-mcp-list', '');
  const showSecret = (token: string): void => {
    const note = document.createElement('p'); note.textContent = 'Copiez ce jeton maintenant : il ne sera plus affiché.';
    const value = document.createElement('code'); value.setAttribute('data-desktop-settings-path', ''); value.textContent = token;
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'blok-button'; copy.setAttribute('data-desktop-settings-copy', ''); copy.textContent = 'Copier le jeton';
    copy.addEventListener('click', () => { void navigator.clipboard.writeText(token).then(() => { copy.textContent = 'Copié'; }).catch(() => { status.textContent = 'Copie impossible : sélectionnez le jeton affiché.'; }); });
    secret.replaceChildren(note, value, copy); secret.hidden = false;
  };
  const refresh = async (): Promise<void> => {
    try {
      const response = await client.request<{tokens: McpToken[]}>('/api/mcp/tokens');
      if (!content.isConnected) return;
      list.replaceChildren();
      if (!response.tokens.length) {
        const empty = document.createElement('div'); empty.setAttribute('data-desktop-mcp-empty', '');
        const title = document.createElement('strong'); title.textContent = 'Aucun jeton actif';
        const hint = document.createElement('p'); hint.textContent = 'Créez un jeton pour connecter votre premier client MCP.';
        empty.append(title, hint); list.append(empty); return;
      }
      for (const token of response.tokens) {
        const row = document.createElement('div'); row.setAttribute('data-desktop-mcp-token', '');
        const text = document.createElement('div'); text.setAttribute('data-desktop-mcp-token-info', '');
        const label = document.createElement('strong'); label.textContent = token.label;
        const expiry = document.createElement('span'); expiry.textContent = expiryText(token.expiresAt);
        text.append(label, expiry);
        const actions = document.createElement('span'); actions.setAttribute('data-desktop-mcp-actions', '');
        const rotate = document.createElement('button'); rotate.type = 'button'; rotate.className = 'blok-button'; rotate.setAttribute('data-desktop-settings-copy', ''); rotate.textContent = 'Renouveler';
        rotate.addEventListener('click', () => { void (async () => {
          rotate.disabled = true;
          try {
            const result = await client.request<{token: string}>(`/api/mcp/tokens/${encodeURIComponent(token.id)}/rotate`, {method: 'POST'});
            if (!content.isConnected) return;
            showSecret(result.token); status.textContent = 'Ancien jeton désactivé. Copiez le nouveau.'; await refresh();
          } catch { status.textContent = 'Impossible de renouveler ce jeton.'; rotate.disabled = false; }
        })(); });
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'blok-button'; revoke.setAttribute('data-desktop-mcp-revoke', ''); revoke.setAttribute('data-desktop-settings-copy', ''); revoke.textContent = 'Révoquer';
        revoke.addEventListener('click', () => { void (async () => {
          revoke.disabled = true;
          try { await client.request(`/api/mcp/tokens/${encodeURIComponent(token.id)}`, {method: 'DELETE'}); status.textContent = 'Jeton révoqué.'; await refresh(); }
          catch { status.textContent = 'Impossible de révoquer ce jeton.'; revoke.disabled = false; }
        })(); });
        actions.append(rotate, revoke); row.append(text, actions); list.append(row);
      }
    } catch { if (content.isConnected) status.textContent = 'Impossible de charger les jetons MCP.'; }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); void (async () => {
    const label = name.value.trim();
    if (!label) { status.textContent = 'Donnez un nom au jeton.'; name.focus(); return; }
    create.disabled = true; secret.replaceChildren(); secret.hidden = true;
    try {
      const result = await client.request<{token: string}>('/api/mcp/tokens', {method: 'POST', body: JSON.stringify({label, expiresIn: lifetime.value})});
      if (!content.isConnected) return;
      showSecret(result.token); name.value = ''; status.textContent = 'Jeton créé.'; await refresh();
    } catch { status.textContent = 'Impossible de créer le jeton.'; }
    finally { create.disabled = false; }
  })(); });
  form.append(nameLabel, lifetimeLabel, create);
  panel.append(heading, help, endpoint, form, status, secret, listHeading, list);
  content.append(panel);
  void refresh();
}
