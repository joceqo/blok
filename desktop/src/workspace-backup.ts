import './workspace-backup.css';
import { createNavigationDialog } from './navigation-modal';
import { nativeBridge, deviceWorkspaces } from './native-runtime';
import { selectWorkspace, type RemoteWorkspace } from './workspace-registry';
import { shellText } from './shell-i18n';

export function openWorkspaceBackup(ref: RemoteWorkspace, flush: () => Promise<void>) {
  const modal = createNavigationDialog(shellText('Sauvegarde de l’espace'));
  const form = document.createElement('form');
  form.className = 'workspace-backup-form';
  const title = document.createElement('h2');
  title.textContent = ref.name;
  function field(label: string, control: HTMLInputElement | HTMLSelectElement) {
    const element = document.createElement('label');
    element.append(shellText(label), control);
    form.append(element);
    return element;
  }
  function select(label: string, items: string[][]) {
    const control = document.createElement('select');
    for (const [value, text] of items) control.add(new Option(shellText(text), value));
    field(label, control);
    return control;
  }
  form.append(title);
  const action = select('Action', [
    ['save', 'Sauvegarder cet espace'],
    ['restore', 'Restaurer dans un nouvel espace'],
  ]);
  const kind = select('Destination', [
    ['folder', 'Dossier, disque externe ou NAS'],
    ['git', 'Dépôt Git (HTTPS)'],
    ['s3', 'Bucket S3 compatible'],
  ]);
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
    input.autocomplete = 'off';
    if (key === 'prefix') input.value = 'blok';
    if (key === 'region') input.value = 'us-east-1';
    return { key, input, label: field(label, input) };
  });
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const submit = document.createElement('button');
  submit.type = 'submit';
  const update = () => {
    for (const item of controls) {
      const visible =
        kind.value === 's3' || (kind.value === 'git' && ['url', 'user', 'token'].includes(item.key));
      item.label.hidden = !visible;
      item.input.disabled = !visible;
      item.input.required = visible && (kind.value === 's3' || item.key === 'url');
    }
    submit.textContent = action.value === 'save' ? shellText('Sauvegarder') : shellText('Restaurer');
    status.textContent =
      action.value === 'restore' ? shellText('La restauration crée une copie sur ce Mac.') : '';
  };
  action.onchange = kind.onchange = update;
  update();
  form.append(submit, status);
  modal.surface.append(form);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    action.disabled = true;
    kind.disabled = true;
    const options = Object.fromEntries(controls.map((c) => [c.key, c.input.disabled ? '' : c.input.value]));
    status.textContent = shellText('Opération en cours…');
    try {
      await flush();
      const result = (await nativeBridge()!.invoke('embedded_workspace_backup', {
        options: { ...options, action: action.value, kind: kind.value, workspace: ref.id },
      })) as { cancelled?: boolean; error?: string; location?: string; workspace?: string };
      if (result.error) throw new Error(result.error);
      if (result.workspace) {
        const { references } = await deviceWorkspaces();
        const restored = references.find((w) => w.id === result.workspace);
        if (!restored) throw new Error('Espace restauré introuvable.');
        modal.close();
        selectWorkspace(restored);
        return;
      }
      status.textContent = result.cancelled
        ? shellText('Annulé')
        : shellText('Sauvegarde terminée') + ' · ' + result.location;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      submit.disabled = false;
      action.disabled = false;
      kind.disabled = false;
    }
  };
  modal.open(action);
}
