import {shellText} from '../shell-i18n';
import { openModalDialog } from '@blok/modal-dialog';
import { IconCross, IconPeople } from '../../../src/components/icons';
import { nativeSessionAdapter } from '../native-session';
import { createChoice, styleTextField, type ChoiceControl } from '../components/dom';
import type { RemoteWorkspace } from '../workspace-registry';
import { CloudApiError, CloudClient } from './client';
import './workspace-settings.css';
import './teamspaces.css';
import {mountTeamspaceSettings} from './teamspace-settings';

interface TeamPage { id: string; title: string }
export interface TeamPageNavigation {
  initialView?: 'create';
  pages(): readonly TeamPage[];
  canEdit(id: string): boolean;
  open(id: string, signal: AbortSignal): Promise<void>;
  onClose?(): void;
}
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
  if (cause.status === 404) return 'Cet élément est introuvable ou son accès a changé. Actualisez les espaces.';
  if (cause.status === 409) return 'Cette personne fait déjà partie de l’équipe. Actualisez les membres.';
  if (cause.message === 'not_workspace_member') return 'Cette personne ne fait plus partie de l’espace de travail.';
  if (cause.status === 0) return cause.message;
  return 'Le serveur n’a pas pu terminer la demande. Réessayez.';
}

/** Filter only the entries returned by the directory. Enter opens its first visible result. */
function filterList(container: HTMLElement, rows: {name:string; row:HTMLLIElement; open:HTMLButtonElement}[],
  label: string, noMatch: string, query: string, onQuery:(query:string)=>void): void {
  const list = el('ul');
  list.className = 'teamspaces-filter-results';
  list.append(...rows.map(item => item.row));
  if (rows.length < 2 && !query) {container.append(list); return;}
  const input = styleTextField(el('input'));
  input.type = 'search'; input.placeholder = label + '…'; input.value = query; input.setAttribute('aria-label',label);
  const status = el('p', noMatch); status.setAttribute('role','status');
  const fold = (value:string) => value.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase().trim();
  function filter() {
    const value = fold(input.value);
    for (const item of rows) item.row.hidden = !fold(item.name).includes(value);
    status.hidden = rows.some(item => !item.row.hidden);
    onQuery(input.value);
  }
  input.addEventListener('input',filter);
  input.addEventListener('keydown',event=>{
    if(event.isComposing || event.key!=='Enter')return;
    const first=rows.find(item=>!item.row.hidden);
    if(first){event.preventDefault();first.open.click();}
  });
  container.append(input,list,status);filter();
}

export function openTeamspaces(ref: RemoteWorkspace, navigation: TeamPageNavigation, transport?: Pick<CloudClient, 'request' | 'workspace'>, host?: HTMLElement): () => void {
  const client = transport ?? new CloudClient({ origin: ref.server,
    sessionAdapter: '__TAURI_INTERNALS__' in window ? nativeSessionAdapter(ref.server) : undefined });
  if (host) return mountTeamspaceSettings(host, ref, navigation, client);
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
  const heading = el('h2', shellText("Espaces d’équipe"));
  heading.id = `teams-${crypto.randomUUID()}`;
  const titles = el('div');
  titles.append(heading, el('p', ref.name));
  const close = action(shellText("Fermer"), () => dismiss());
  close.setAttribute('aria-label', shellText("Fermer"));
  close.innerHTML = IconCross;
  header.append(titles);
  header.append(close);
  const layout = el('div');
  layout.className = 'teamspaces-layout';
  const nav = el('nav');
  nav.setAttribute('aria-label', shellText("Liste des espaces d’équipe"));
  const detail = el('section');
  detail.setAttribute('aria-label', shellText("Détails de l’équipe"));
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
  let peoplePanel = el('div');
  let picker: ChoiceControl<string> | undefined;
  let reading = new AbortController();
  let writing = false;
  let closed = false;
  function dispose() {
    if (closed) return;
    closed = true; reading.abort(); picker?.destroy(); panel.remove(); navigation.onClose?.();
  }
  const dialog = openModalDialog({ content: overlay, surface: panel, labelledBy: heading.id,
    initialFocus: () => close, onDismiss: () => dismiss(), onClose: dispose,
  });
  function dismiss() { dialog.close(); }

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
    error.replaceChildren(el('span', errorMessage(cause)), action(shellText("Actualiser"), () => { void loadDirectory(true); }));
  }
  let directoryQuery = '';
  let pendingCreation = navigation.initialView === 'create';
  function renderNav(): void {
    nav.replaceChildren();
    if (canManage) nav.append(action(shellText("Nouvel espace d’équipe"), () => nameForm(), true));
    if (!teams.length) { nav.append(el('p', shellText("Aucun espace d’équipe."))); return; }
    const rows = teams.map(team => {
      const open = action(team.name, () => { void openTeam(team, true); });
      open.className = 'teamspaces-item';
      open.setAttribute('aria-current', team.id === selected?.id ? 'true' : 'false');
      const mark = el('span'); mark.innerHTML = IconPeople; mark.setAttribute('aria-hidden', 'true');
      const row = el('li'); open.prepend(mark); row.append(open);
      return {name:team.name, row, open};
    });
    filterList(nav, rows, shellText("Rechercher un espace d’équipe"), 'Aucun espace ne correspond à votre recherche.',
      directoryQuery, value => {directoryQuery=value;});
  }
  async function loadDirectory(refreshRole = false): Promise<void> {
    if (writing || closed) return;
    const signal = startView();
    nav.replaceChildren(el('p', shellText("Chargement des espaces…")));
    try {
      if (refreshRole) {
        const current = await client.workspace(ref.workspaceId, signal);
        if (signal.aborted) return;
        canManage = current.role === 'admin' || current.role === 'member';
      }
      const data = await client.request<{teamspaces: Teamspace[]}>(base, { signal });
      if (signal.aborted) return;
      teams = data.teamspaces;
      const openCreation = pendingCreation && canManage;
      pendingCreation = false;
      selected = openCreation ? undefined : teams.find((team) => team.id === selected?.id) ?? teams[0];
      renderNav();
      if (openCreation) nameForm();
      else if (selected) await openTeam(selected);
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
    members = [];
    renderTeam(team);
    peoplePanel.replaceChildren(el('p', shellText("Chargement des membres…")));
    if (focus) detail.focus();
    try {
      const data = await client.request<{members: Member[]}>(url(team) + '/members', { signal });
      if (signal.aborted) return;
      members = data.members;
      renderMembers(team);
    } catch (cause) {
      if (signal.aborted) return;
      peoplePanel.replaceChildren(); showError(cause);
    }
  }
  async function mutate<T>(path: string, method: string, body: object | undefined, done: (value: T) => void): Promise<void> {
    if (writing || !canManage || closed) return;
    writing = true; nav.inert = true; detail.inert = true; error.hidden = true;
    panel.setAttribute('aria-busy', 'true');
    let result: T;
    const signal = reading.signal;
    try {
      result = await client.request<T>(path, { method, signal, body: body ? JSON.stringify(body) : undefined });
    } catch (cause) {
      if (!signal.aborted) showError(cause);
      return;
    } finally {
      writing = false; nav.inert = false; detail.inert = false;
      panel.removeAttribute('aria-busy');
    }
    if (!signal.aborted) done(result);
  }
  function nameForm(team?: Teamspace): void {
    if (writing || !canManage) return;
    startView();
    const form = el('form');
    const title = team ? 'Renommer l’espace d’équipe' : 'Nouvel espace d’équipe';
    const label = el('label', shellText("Nom de l’équipe"));
    const input = styleTextField(el('input'));
    input.value = team?.name ?? ''; input.required = true; label.append(input);
    const submit = el('button', team ? shellText("Enregistrer") : shellText("Créer"));
    submit.type = 'submit'; submit.setAttribute('data-cloud-settings-button', ''); submit.setAttribute('data-cloud-settings-primary', '');
    const update = () => { submit.disabled = !input.value.trim() || input.value.trim() === team?.name; };
    input.addEventListener('input', update); update();
    const actions = el('div'); actions.className = 'teamspaces-actions';
    actions.append(action(shellText("Annuler"), () => { void loadDirectory(); }), submit);
    form.append(el('h3', title), label, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name || name === team?.name) return;
      void mutate<{teamspace: Teamspace}>(team ? url(team) : base, team ? 'PATCH' : 'POST', { name }, ({teamspace}) => {
        teams = team ? teams.map((item) => item.id === team.id ? teamspace : item) : [...teams, teamspace];
        directoryQuery = '';
        void openTeam(teamspace, true);
      });
    });
    detail.append(form); input.focus(); input.select();
  }
  function removeForm(team: Teamspace): void {
    if (writing || !canManage) return;
    startView();
    const cancel = action(shellText("Annuler"), () => { void openTeam(team, true); });
    detail.append(el('h3', shellText("Supprimer « {v0} » ?", {v0: team.name})), el('p', shellText("Ses membres et ses liens vers les pages seront retirés. Les pages resteront dans l’espace de travail.")),
      cancel, action(shellText("Confirmer la suppression"), () => {
        void mutate(url(team), 'DELETE', undefined, () => { selected = undefined; void loadDirectory(); });
      }));
    cancel.focus();
  }
  function renderTeam(team: Teamspace): void {
    picker?.destroy(); picker = undefined;
    detail.replaceChildren(el('h3', team.name));
    if (canManage) {
      const controls = el('div'); controls.className = 'teamspaces-actions';
      controls.append(action(shellText("Renommer"), () => nameForm(team)), action(shellText("Supprimer"), () => removeForm(team)));
      detail.append(controls);
    }
    peoplePanel = el('div');
    peoplePanel.className = 'teamspaces-content';
    detail.append(teamPages(team, reading.signal), peoplePanel);
    renderMembers(team);
  }
  function renderMembers(team: Teamspace): void {
    peoplePanel.replaceChildren();
    peoplePanel.append(el('h4', shellText("Membres ({v0})", {v0: members.length})));
    if (!members.length) peoplePanel.append(el('p', shellText("Aucun membre dans cette équipe.")));
    const list = el('ul');
    for (const member of members) {
      const row = el('li'); row.append(el('span', member.email));
      if (canManage) {
        const remove = action(shellText("Retirer"), () => {
          void mutate(url(team) + '/members/' + encodeURIComponent(member.userId), 'DELETE', undefined, () => {
            members = members.filter((item) => item.userId !== member.userId); renderMembers(team); detail.focus();
          });
        });
        remove.setAttribute('aria-label', shellText("Retirer {v0} de l’équipe", {v0: member.email})); row.append(remove);
      }
      list.append(row);
    }
    peoplePanel.append(list);
    if (canManage) peoplePanel.append(action(shellText("Ajouter un membre"), () => { void addForm(team); }));
  }
  function teamPages(team: Teamspace, signal: AbortSignal): HTMLElement {
    const region = el('div');
    region.className = 'teamspaces-content';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', shellText("Pages de l’équipe"));
    const path = url(team) + '/pages';
    let attached: TeamPage[] = [];
    let pageQuery = '';
    let pagePicker: ChoiceControl<string> | undefined;
    signal.addEventListener('abort', () => pagePicker?.destroy(), {once: true});

    function editable(id: string): boolean {
      return canManage && navigation.canEdit(id);
    }
    async function openPage(id: string): Promise<void> {
      try {
        await navigation.open(id, signal);
        if (!signal.aborted) dismiss();
      } catch (cause) {
        if (!signal.aborted) showError(cause);
      }
    }
    function writeLink(id: string, method: 'PUT' | 'DELETE'): void {
      if (signal.aborted) return;
      if (!editable(id) || !navigation.pages().some((page) => page.id === id)) { showError(new CloudApiError(403, '')); return; }
      void mutate(path + '/' + encodeURIComponent(id), method, undefined, () => { void load(); });
    }
    function choosePage(): void {
      const linked = new Set(attached.map((page) => page.id));
      const candidates = navigation.pages().filter(({id}) => !linked.has(id) && editable(id));
      region.replaceChildren(el('h4', shellText("Rattacher une page")));
      const cancel = action(shellText("Annuler"), render);
      if (!candidates.length) {
        region.append(el('p', shellText("Aucune autre page modifiable à rattacher.")), cancel); cancel.focus(); return;
      }
      const submit = action(shellText("Rattacher"), () => { if (pagePicker?.value) writeLink(pagePicker.value, 'PUT'); }, true);
      submit.disabled = true;
      pagePicker = createChoice({ label: shellText("Choisir une page"), value: '', searchable: true,
        options: [{value: '', label: shellText("Rechercher une page…"), disabled: true},
          ...candidates.map((page) => ({ value: page.id, label: page.title || shellText("Sans titre") }))],
        onChange: () => { submit.disabled = false; },
      });
      const controls = el('div'); controls.className = 'teamspaces-actions'; controls.append(cancel, submit);
      region.append(pagePicker.element, el('p', shellText("Les droits de cette page se gèrent dans son menu Partager.")), controls);
      pagePicker.element.focus();
    }
    function render(): void {
      pagePicker?.destroy(); pagePicker = undefined;
      region.replaceChildren(el('h4', shellText("Pages de l’équipe ({v0})", {v0: attached.length})));
      if (!attached.length) region.append(el('p', shellText("Aucune page accessible rattachée à cette équipe.")));
      const rows = attached.map(page => {
        const row = el('li');
        const title = page.title || 'Sans titre';
        const open = action(title, () => { void openPage(page.id); });
        open.className = 'teamspaces-page'; row.append(open);
        if (editable(page.id)) {
          const detach = action(shellText("Détacher"), () => writeLink(page.id, 'DELETE'));
          detach.setAttribute('aria-label', shellText("Détacher {v0} de l’équipe", {v0: title})); row.append(detach);
        }
        return {name:title,row,open};
      });
      if (rows.length) filterList(region, rows, shellText("Rechercher une page de cette équipe"), 'Aucune page ne correspond à votre recherche.',
        pageQuery, value => {pageQuery=value;});
      if (canManage) region.append(action(shellText("Rattacher une page"), choosePage));
    }
    async function load(): Promise<void> {
      pagePicker?.destroy(); pagePicker = undefined;
      region.replaceChildren(el('h4', shellText("Pages de l’équipe")), el('p', shellText("Chargement des pages…")));
      try {
        const data = await client.request<{pages: TeamPage[]}>(path, {signal});
        if (signal.aborted) return;
        attached = data.pages;
        render();
      } catch (cause) {
        if (signal.aborted) return;
        region.replaceChildren(el('h4', shellText("Pages de l’équipe")), el('p', errorMessage(cause)),
          action(shellText("Actualiser les pages"), () => { void load(); }));
      }
    }
    void load();
    return region;
  }
  async function addForm(team: Teamspace): Promise<void> {
    if (writing || !canManage) return;
    const signal = startView();
    const title = el('h3', shellText("Ajouter un membre à « {v0} »", {v0: team.name}));
    const cancel = action(shellText("Annuler"), () => { void openTeam(team, true); });
    detail.append(title, el('p', shellText("Chargement des membres de l’espace de travail…")), cancel);
    cancel.focus();
    try {
      const result = await client.request<{members: {id: string; email: string; name?: string}[]}>(workspace + '/members', {signal});
      if (signal.aborted) return;
      const existing = new Set(members.map((member) => member.userId));
      const options = result.members.filter((item) => !existing.has(item.id)).map((item) => ({ value: item.id, label: item.name ? item.name + ' · ' + item.email : item.email }));
      detail.replaceChildren(title);
      if (!options.length) { detail.append(el('p', shellText("Tous les membres de l’espace de travail sont déjà dans cette équipe.")), cancel); cancel.focus(); return; }
      const add = action(shellText("Ajouter"), () => {
        if (!picker?.value) return;
        void mutate<{member: Member}>(url(team) + '/members', 'POST', { userId: picker.value }, ({member}) => {
          members = [...members, member].sort((a, b) => a.email.localeCompare(b.email));
          renderTeam(team); detail.focus();
        });
      }, true);
      add.disabled = true;
      picker = createChoice({ label: shellText("Choisir une personne"), value: '', searchable: true,
        options: [{ value: '', label: shellText("Rechercher un membre…"), disabled: true }, ...options],
        onChange: () => { add.disabled = false; },
      });
      const actions = el('div'); actions.className = 'teamspaces-actions'; actions.append(cancel, add);
      detail.append(picker.element, actions); picker.element.focus();
    } catch (cause) {
      if (signal.aborted) return;
      detail.replaceChildren(title, cancel); showError(cause);
    }
  }
  void loadDirectory(pendingCreation);
  return dismiss;
}
