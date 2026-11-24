import { openModalDialog } from '@blok/modal-dialog';
import { IconCross, IconPeople } from '../../../src/components/icons';
import { nativeSessionAdapter } from '../native-session';
import { createChoice, styleTextField, type ChoiceControl } from '../ui/controls';
import type { RemoteWorkspace } from '../workspace-registry';
import { CloudApiError, CloudClient } from './client';
import './workspace-settings.css';
import './teamspaces.css';

interface Teamspace { id: string; name: string }
interface Member { userId: string; email: string }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function action(label: string, run: () => void, primary = false): HTMLButtonElement {
  const button = el('button', label);
  button.type = 'button';
  button.setAttribute('data-cloud-settings-button', '');
  button.toggleAttribute('data-cloud-settings-primary', primary);
  button.addEventListener('click', run);
  return button;
}
function errorMessage(cause: unknown): string {
  if (!(cause instanceof CloudApiError)) return 'La demande a échoué. Réessayez.';
  if (cause.status === 401) return 'Votre session a expiré. Reconnectez-vous pour continuer.';
  if (cause.status === 403) return 'Vos droits ne permettent plus cette action. Actualisez les espaces.';
  if (cause.status === 404) return 'Cette équipe ou ce membre est introuvable. Actualisez les espaces.';
  if (cause.status === 409) return 'Cette personne fait déjà partie de l’équipe. Actualisez les membres.';
  if (cause.message === 'not_workspace_member') return 'Cette personne ne fait plus partie de l’espace de travail.';
  if (cause.status === 0) return cause.message;
  return 'Le serveur n’a pas pu terminer la demande. Réessayez.';
}

export function openTeamspaces(ref: RemoteWorkspace): void {
  const client = new CloudClient({ origin: ref.server,
    sessionAdapter: '__TAURI_INTERNALS__' in window ? nativeSessionAdapter(ref.server) : undefined });
  const workspace = `/api/workspaces/${encodeURIComponent(ref.workspaceId)}`;
  const base = workspace + '/teamspaces';
  const url = (team: Teamspace) => base + '/' + encodeURIComponent(team.id);
  let canManage = ref.role === 'admin' || ref.role === 'member';
  const overlay = el('div');
  overlay.setAttribute('data-desktop-settings-overlay', '');
  const panel = el('section');
  panel.setAttribute('data-teamspaces', '');
  panel.tabIndex = -1;
  const header = el('header');
  const heading = el('h2', 'Espaces d’équipe');
  heading.id = `teams-${crypto.randomUUID()}`;
  const titles = el('div');
  titles.append(heading, el('p', ref.name));
  const close = action('Fermer', () => dialog.close());
  close.setAttribute('aria-label', 'Fermer');
  close.innerHTML = IconCross;
  header.append(titles, close);
  const layout = el('div');
  layout.className = 'teamspaces-layout';
  const nav = el('nav');
  nav.setAttribute('aria-label', 'Liste des espaces d’équipe');
  const detail = el('section');
  detail.setAttribute('aria-label', 'Détails de l’équipe');
  detail.tabIndex = -1;
  const error = el('div');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  layout.append(nav, detail);
  panel.append(header, error, layout);
  overlay.append(panel);

  let teams: Teamspace[] = [];
  let selected: Teamspace | undefined;
  let members: Member[] = [];
  let picker: ChoiceControl<string> | undefined;
  let reading = new AbortController();
  let writing = false;
  let closed = false;
  const dialog = openModalDialog({ content: overlay, surface: panel, labelledBy: heading.id,
    initialFocus: () => close, onDismiss: () => dialog.close(),
    onClose: () => { closed = true; reading.abort(); picker?.destroy(); },
  });

  function startView(): AbortSignal {
    reading.abort();
    reading = new AbortController();
    picker?.destroy(); picker = undefined;
    error.hidden = true;
    detail.replaceChildren();
    return reading.signal;
  }
  function showError(cause: unknown): void {
    if (closed) return;
    error.hidden = false;
    error.replaceChildren(el('span', errorMessage(cause)), action('Actualiser', () => { void loadDirectory(true); }));
  }
  function renderNav(): void {
    nav.replaceChildren();
    if (canManage) nav.append(action('Nouvel espace d’équipe', () => nameForm(), true));
    if (!teams.length) nav.append(el('p', 'Aucun espace d’équipe.'));
    for (const team of teams) {
      const button = action(team.name, () => { void openTeam(team, true); });
      button.className = 'teamspaces-item';
      button.setAttribute('aria-current', team.id === selected?.id ? 'true' : 'false');
      const mark = el('span'); mark.innerHTML = IconPeople; mark.setAttribute('aria-hidden', 'true');
      button.prepend(mark); nav.append(button);
    }
  }
  async function loadDirectory(refreshRole = false): Promise<void> {
    if (writing || closed) return;
    const signal = startView();
    nav.replaceChildren(el('p', 'Chargement des espaces…'));
    try {
      if (refreshRole) {
        const current = await client.workspace(ref.workspaceId);
        if (signal.aborted) return;
        canManage = current.role === 'admin' || current.role === 'member';
      }
      const data = await client.request<{teamspaces: Teamspace[]}>(base, { signal });
      if (signal.aborted) return;
      teams = data.teamspaces;
      selected = teams.find((team) => team.id === selected?.id) ?? teams[0];
      renderNav();
      if (selected) await openTeam(selected);
    } catch (cause) {
      if (signal.aborted) return;
      nav.replaceChildren(); showError(cause);
    }
  }
  async function openTeam(team: Teamspace, focus = false): Promise<void> {
    if (writing || closed) return;
    const signal = startView();
    selected = team;
    renderNav();
    detail.append(el('h3', team.name), el('p', 'Chargement des membres…'));
    if (focus) detail.focus();
    try {
      const data = await client.request<{members: Member[]}>(url(team) + '/members', { signal });
      if (signal.aborted) return;
      members = data.members;
      renderTeam(team);
    } catch (cause) {
      if (signal.aborted) return;
      detail.replaceChildren(el('h3', team.name)); showError(cause);
    }
  }
  async function mutate<T>(path: string, method: string, body: object | undefined, done: (value: T) => void): Promise<void> {
    if (writing || !canManage || closed) return;
    writing = true; nav.inert = true; detail.inert = true; error.hidden = true;
    panel.setAttribute('aria-busy', 'true');
    let result: T;
    try {
      result = await client.request<T>(path, { method, body: body ? JSON.stringify(body) : undefined });
    } catch (cause) {
      showError(cause);
      return;
    } finally {
      writing = false; nav.inert = false; detail.inert = false;
      panel.removeAttribute('aria-busy');
    }
    if (!closed) done(result);
  }
  function nameForm(team?: Teamspace): void {
    if (writing || !canManage) return;
    startView();
    const form = el('form');
    const title = team ? 'Renommer l’espace d’équipe' : 'Nouvel espace d’équipe';
    const label = el('label', 'Nom de l’équipe');
    const input = styleTextField(el('input'));
    input.value = team?.name ?? ''; input.required = true; label.append(input);
    const submit = el('button', team ? 'Enregistrer' : 'Créer');
    submit.type = 'submit'; submit.setAttribute('data-cloud-settings-button', ''); submit.setAttribute('data-cloud-settings-primary', '');
    const update = () => { submit.disabled = !input.value.trim() || input.value.trim() === team?.name; };
    input.addEventListener('input', update); update();
    const actions = el('div'); actions.className = 'teamspaces-actions';
    actions.append(action('Annuler', () => { void loadDirectory(); }), submit);
    form.append(el('h3', title), label, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name || name === team?.name) return;
      void mutate<{teamspace: Teamspace}>(team ? url(team) : base, team ? 'PATCH' : 'POST', { name }, ({teamspace}) => {
        teams = team ? teams.map((item) => item.id === team.id ? teamspace : item) : [...teams, teamspace];
        void openTeam(teamspace, true);
      });
    });
    detail.append(form); input.focus(); input.select();
  }
  function removeForm(team: Teamspace): void {
    if (writing || !canManage) return;
    startView();
    const cancel = action('Annuler', () => { void openTeam(team, true); });
    detail.append(el('h3', `Supprimer « ${team.name} » ?`), el('p', 'La liste des membres de cette équipe sera supprimée.'),
      cancel, action('Confirmer la suppression', () => {
        void mutate(url(team), 'DELETE', undefined, () => { selected = undefined; void loadDirectory(); });
      }));
    cancel.focus();
  }
  function renderTeam(team: Teamspace): void {
    picker?.destroy(); picker = undefined;
    detail.replaceChildren(el('h3', team.name));
    if (canManage) {
      const controls = el('div'); controls.className = 'teamspaces-actions';
      controls.append(action('Renommer', () => nameForm(team)), action('Supprimer', () => removeForm(team)));
      detail.append(controls);
    }
    detail.append(el('h4', `Membres (${members.length})`));
    if (!members.length) detail.append(el('p', 'Aucun membre dans cette équipe.'));
    const list = el('ul');
    for (const member of members) {
      const row = el('li'); row.append(el('span', member.email));
      if (canManage) {
        const remove = action('Retirer', () => {
          void mutate(url(team) + '/members/' + encodeURIComponent(member.userId), 'DELETE', undefined, () => {
            members = members.filter((item) => item.userId !== member.userId); renderTeam(team); detail.focus();
          });
        });
        remove.setAttribute('aria-label', `Retirer ${member.email} de l’équipe`); row.append(remove);
      }
      list.append(row);
    }
    detail.append(list);
    if (canManage) detail.append(action('Ajouter un membre', () => { void addForm(team); }));
  }
  async function addForm(team: Teamspace): Promise<void> {
    if (writing || !canManage) return;
    const signal = startView();
    const title = el('h3', `Ajouter un membre à « ${team.name} »`);
    const cancel = action('Annuler', () => { void openTeam(team, true); });
    detail.append(title, el('p', 'Chargement des membres de l’espace de travail…'), cancel);
    cancel.focus();
    try {
      const result = await client.request<{members: {id: string; email: string}[]}>(workspace + '/members', {signal});
      if (signal.aborted) return;
      const existing = new Set(members.map((member) => member.userId));
      const options = result.members.filter((item) => !existing.has(item.id)).map((item) => ({ value: item.id, label: item.email }));
      detail.replaceChildren(title);
      if (!options.length) { detail.append(el('p', 'Tous les membres de l’espace de travail sont déjà dans cette équipe.'), cancel); cancel.focus(); return; }
      const add = action('Ajouter', () => {
        if (!picker?.value) return;
        void mutate<{member: Member}>(url(team) + '/members', 'POST', { userId: picker.value }, ({member}) => {
          members = [...members, member].sort((a, b) => a.email.localeCompare(b.email));
          renderTeam(team); detail.focus();
        });
      }, true);
      add.disabled = true;
      picker = createChoice({ label: 'Choisir une personne', value: '', searchable: true,
        options: [{ value: '', label: 'Rechercher un membre…', disabled: true }, ...options],
        onChange: () => { add.disabled = false; },
      });
      const actions = el('div'); actions.className = 'teamspaces-actions'; actions.append(cancel, add);
      detail.append(picker.element, actions); picker.element.focus();
    } catch (cause) {
      if (signal.aborted) return;
      detail.replaceChildren(title, cancel); showError(cause);
    }
  }
  void loadDirectory();
}
