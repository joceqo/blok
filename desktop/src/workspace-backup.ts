import './workspace-backup.css';
import { createChoice } from './components/dom';
import { nativeBridge, deviceWorkspaces } from './native-runtime';
import { selectWorkspace, type RemoteWorkspace } from './workspace-registry';
import { shellText } from './shell-i18n';

type Destination = { kind: 'folder' | 'git' | 's3'; url?: string; user?: string; bucket?: string; region?: string; prefix?: string };

export function mountWorkspaceBackup(container: HTMLElement, ref: RemoteWorkspace, flush: () => Promise<void>) {
  const key = 'blok:desktop:backup-destination:' + ref.id;
  let saved: Destination = { kind: 'folder' };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && ['folder', 'git', 's3'].includes(value.kind)) saved = value;
  } catch { /* A missing or unreadable preference starts with the folder picker. */ }
  const form = document.createElement('form');
  form.className = 'workspace-backup-form';
  function field(label: string, control: HTMLInputElement) {
    const element = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent = shellText(label);
    element.append(caption, control);
    form.append(element);
    return element;
  }
  function choice(label: string, value: string, options: [string, string][], onChange: () => void) {
    const caption = document.createElement('span');
    caption.textContent = shellText(label);
    const control = createChoice({
      label: caption.textContent,
      value,
      options: options.map(([value, text]) => ({ value, label: shellText(text) })),
      onChange,
    });
    const row = document.createElement('div');
    row.className = 'workspace-backup-choice';
    row.append(caption, control.element);
    form.append(row);
    return control;
  }
  const action = choice('Action', 'save', [
    ['save', 'Sauvegarder cet espace'],
    ['restore', 'Restaurer dans un nouvel espace'],
  ], () => { kind.setValue(saved.kind); loadDestination(); update(); });
  const kind = choice('Destination', saved.kind, [
    ['folder', 'Dossier, disque externe ou NAS'],
    ['git', 'Dépôt Git (HTTPS)'],
    ['s3', 'Bucket S3 compatible'],
  ], () => { loadDestination(); update(); });
  kind.element.dataset.backupDestination = '';
  const controls = [
    ['url', 'URL du dépôt ou du service S3', 'url'],
    ['user', 'Utilisateur Git ou clé d’accès S3', 'text'],
    ['token', 'Jeton Git ou secret S3', 'password'],
    ['bucket', 'Bucket', 'text'],
    ['region', 'Région', 'text'],
    ['prefix', 'Chemin de la sauvegarde', 'text'],
  ].map(([key, label, type]) => {
    const input = document.createElement('input');
    input.type = type;
    input.name = key;
    input.setAttribute('data-blok-field', '');
    input.autocomplete = 'off';
    if (key === 'prefix') input.value = 'blok';
    if (key === 'region') input.value = 'us-east-1';
    return { key, input, label: field(label, input) };
  });
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const submit = document.createElement('button');
  submit.type = 'submit';
  const remember = document.createElement('button');
  remember.type = 'button';
  remember.textContent = shellText('Enregistrer la destination');
  function loadDestination() {
    for (const { key, input } of controls) {
      const previous = saved.kind === kind.value && key !== 'token' && Object.hasOwn(saved, key) ? saved[key as keyof Destination] : undefined;
      input.value = typeof previous === 'string' ? previous : key === 'region' ? 'us-east-1' : key === 'prefix' ? 'blok' : '';
    }
  }
  function preference(): Destination {
    const selected = kind.value as Destination['kind'];
    if (selected === 'folder') return { kind: selected };
    const values = Object.fromEntries(controls.map(c => [c.key, c.input.value.trim()]));
    const url = new URL(values.url);
    if ((url.protocol !== 'https:' && !(selected === 's3' && url.protocol === 'http:' && url.hostname === '127.0.0.1')) ||
        url.username || url.password || url.hash || url.search) throw new Error(shellText('Indiquez une URL de service sans identifiants.'));
    return selected === 'git' ? {kind: selected, url: url.href, user: values.user} :
      {kind: selected, url: url.href, bucket: values.bucket, region: values.region, prefix: values.prefix};
  }
  function persist(value: Destination) {
    localStorage.setItem(key, JSON.stringify(value));
    saved = value;
  }
  remember.onclick = () => {
    try {
      for (const {key, input} of controls) {
        if (!input.disabled && key !== 'user' && key !== 'token' && !input.reportValidity()) return;
      }
      persist(preference());
      status.textContent = shellText('Destination enregistrée pour cet espace.');
    } catch (error) { status.textContent = String(error); }
  };
  const update = () => {
    remember.hidden = action.value === 'restore';
    for (const item of controls) {
      const visible =
        kind.value === 's3' || (kind.value === 'git' && ['url', 'user', 'token'].includes(item.key));
      if (item.key === 'url') item.label.firstElementChild!.textContent = kind.value === 'git' ? shellText('URL HTTPS du dépôt Git') : shellText('URL du service S3');
      if (item.key === 'user') item.label.firstElementChild!.textContent = kind.value === 'git' ? shellText('Utilisateur Git') : shellText('Clé d’accès S3');
      if (item.key === 'token') item.label.firstElementChild!.textContent = kind.value === 'git' ? shellText('Jeton Git') : shellText('Secret S3');
      item.label.hidden = !visible;
      item.input.disabled = !visible;
      item.input.required = visible && (kind.value === 's3' || item.key === 'url');
    }
    submit.textContent = action.value === 'save' ? shellText('Sauvegarder') : shellText('Restaurer');
    status.textContent =
      action.value === 'restore' ? shellText('La restauration crée une copie sur ce Mac.') : '';
  };
  loadDestination();
  update();
  const actions = document.createElement('div');
  actions.className = 'workspace-backup-actions';
  actions.append(remember, submit);
  form.append(actions, status);
  container.append(form);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    action.disabled = true;
    kind.disabled = true;
    const options = Object.fromEntries(controls.map((c) => [c.key, c.input.disabled ? '' : c.input.value]));
    status.textContent = shellText('Opération en cours…');
    try {
      const destination = action.value === 'save' ? preference() : undefined;
      remember.disabled = true;
      for (const {input} of controls) input.readOnly = true;
      await flush();
      const result = (await nativeBridge()!.invoke('embedded_workspace_backup', {
        options: { ...options, action: action.value, kind: kind.value, workspace: ref.id },
      })) as { cancelled?: boolean; error?: string; location?: string; workspace?: string };
      if (result.error) throw new Error(result.error);
      if (result.workspace) {
        const { references } = await deviceWorkspaces();
        const restored = references.find((w) => w.id === result.workspace);
        if (!restored) throw new Error('Espace restauré introuvable.');
        selectWorkspace(restored);
        return;
      }
      if (!result.cancelled && destination) persist(destination);
      status.textContent = result.cancelled
        ? shellText('Annulé')
        : shellText('Sauvegarde terminée') + ' · ' + result.location;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      for (const {input} of controls) input.readOnly = false;
      remember.disabled = false;
      submit.disabled = false;
      action.disabled = false;
      kind.disabled = false;
    }
  };
  return { destroy() { action.destroy(); kind.destroy(); } };
}
