import { createNavigationDialog } from '../navigation-dialogs';
import { nativeSessionAdapter } from '../native-session';
import type { WorkspaceIndex } from '../storage';
import type { RemoteWorkspace } from '../workspace-registry';
import { CloudApiError, CloudClient } from './client';
import './workspace-settings.css';

export function openRemoteTrash(
  ref: RemoteWorkspace,
  flush: () => Promise<unknown>,
  changed: () => Promise<void>,
  client: Pick<CloudClient, 'request'> = new CloudClient({
    origin: ref.server,
    sessionAdapter: '__TAURI_INTERNALS__' in window ? nativeSessionAdapter(ref.server) : undefined,
  }),
) {
  const base = '/api/workspaces/' + encodeURIComponent(ref.workspaceId);
  const controller = new AbortController();
  const modal = createNavigationDialog('Corbeille');
  modal.surface.setAttribute('data-workspace-trash', '');
  const title = document.createElement('h2');
  title.setAttribute('data-navigation-heading', '');
  title.textContent = 'Corbeille';
  const list = document.createElement('ul');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  modal.surface.append(title, list, status);
  let busy = false;

  function button(label: string, run: () => void) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.setAttribute('data-cloud-settings-button', '');
    node.onclick = run;
    return node;
  }

  async function refresh(message = '') {
    await flush();
    const index = await client.request<WorkspaceIndex & { revision: number }>(base + '/index', { signal: controller.signal });
    if (controller.signal.aborted) return;
    list.replaceChildren();
    const inTrash = new Set(index.trash?.map(page => page.id));
    for (const page of index.trash ?? []) {
      const name = page.title || 'Sans titre';
      const row = document.createElement('li');
      const caption = document.createElement('span');
      caption.textContent = name;
      row.append(caption);
      list.append(row);
      if ((ref.role !== 'admin' && ref.role !== 'member') || index.access?.[page.id]?.level !== 'full')
        continue;
      const restore = button('Restaurer', () => void restorePage(page.id, name, index.revision, restore));
      restore.setAttribute('aria-label', 'Restaurer « ' + name + ' »');
      const unavailable = index.access[page.id].sharedRoot ? 'Emplacement d’origine inaccessible.' :
        page.parentId && inTrash.has(page.parentId) ? 'Restaurez d’abord la page parente.' : '';
      restore.disabled = Boolean(unavailable) || !Number.isSafeInteger(index.revision);
      restore.title = unavailable || 'Restaurer uniquement cette page à son emplacement d’origine';
      if (unavailable) {
        const detail = document.createElement('small');
        detail.textContent = unavailable;
        caption.append(document.createElement('br'), detail);
      }
      const remove = button('Supprimer…', () => {
        if (busy) return;
        const question = document.createElement('p');
        question.textContent = 'Supprimer définitivement « ' + name + ' » et son historique ?';
        const cancel = button('Annuler', () => {
          row.replaceChildren(caption, restore, remove);
          remove.focus();
        });
        const confirm = button('Supprimer définitivement', () => {
          void purge(page.id, name, confirm, cancel);
        });
        row.replaceChildren(question, cancel, confirm);
        cancel.focus();
      });
      remove.setAttribute('aria-label', 'Supprimer définitivement « ' + name + ' »');
      row.append(restore, remove);
    }
    status.textContent = [message, !list.children.length && 'La corbeille est vide.']
      .filter(Boolean)
      .join(' ');
  }

  function failure(error: unknown, restoring = false) {
    if (controller.signal.aborted) return;
    if (error instanceof CloudApiError && error.status === 403) {
      status.textContent = 'Vous n’avez plus les droits nécessaires.';
    } else if (error instanceof CloudApiError && error.status === 404) {
      status.textContent = 'La page est introuvable ou inaccessible.';
    } else if (error instanceof CloudApiError && error.status === 409) {
      status.textContent = restoring ? 'La page ou son emplacement a changé. Actualisez la corbeille.' :
        'Vérifiez que la page est dans la corbeille. Supprimez ou déplacez d’abord ses sous-pages.';
    } else {
      status.textContent = 'La demande a échoué. Actualisez la corbeille puis réessayez.';
    }
    status.append(
      ' ',
      button('Actualiser', () => {
        void refresh().catch(failure);
      }),
    );
  }

  async function restorePage(id: string, name: string, revision: number, control: HTMLButtonElement) {
    if (busy) return;
    busy = true;
    control.disabled = true;
    try {
      await flush();
      if (controller.signal.aborted) return;
      const result = await client.request<{restored: string}>(
        base + '/pages/' + encodeURIComponent(id) + '/restore-from-trash',
        {method:'POST', body: JSON.stringify({revision})},
      );
      if (result.restored !== id) throw new Error('Unconfirmed restoration');
      await changed();
      if (controller.signal.aborted) return;
      await refresh('« ' + name + ' » a été restaurée.');
      modal.surface.focus();
    } catch (error) {
      failure(error, true);
      control.disabled = false;
    } finally { busy = false; }
  }

  async function purge(id: string, name: string, confirm: HTMLButtonElement, cancel: HTMLButtonElement) {
    if (busy) return;
    busy = true;
    confirm.disabled = true;
    cancel.disabled = true;
    try {
      const result = await client.request<{ purged?: string; pending?: string }>(
        base + '/pages/' + encodeURIComponent(id) + '/purge',
        { method: 'DELETE' },
      );
      if (result.purged !== id && result.pending !== id) throw new Error('Unconfirmed purge');
      await changed();
      if (controller.signal.aborted) return;
      await refresh(
        result.purged === id
          ? '« ' + name + ' » a été supprimée.'
          : 'Suppression de « ' + name + ' » en cours.',
      );
      modal.surface.focus();
    } catch (error) {
      failure(error);
      cancel.disabled = false;
      confirm.disabled = false;
    } finally {
      busy = false;
    }
  }

  status.textContent = 'Chargement…';
  modal.open(modal.surface, () => controller.abort());
  void refresh().catch(failure);
  return modal.close;
}
