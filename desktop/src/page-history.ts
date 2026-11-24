import { openModalDialog } from '@blok/modal-dialog';
import { historyChangeDetails } from './history-change-details';
import { IconCross } from '../../src/components/icons';
import { blocksToHtml } from '@bloklabs/core/view';
import './page-history.css';

interface Version {
  lineage: string;
  sequence: number;
  savedAt: number | null;
}
interface Preview {
  expectRevision: string;
  fits: boolean;
  guards: Array<{ kind: string; blockId: string }>;
}
interface HistoryOptions {
  base: string;
  title: string;
  ticket: () => Promise<string>;
  editable: () => boolean;
  flush: () => Promise<void>;
}

const guardLabels: Record<string, string> = {
  unlock: 'Déverrouiller la base de données',
  lockedReshape: 'Modifier une base de données verrouillée',
  share: 'Modifier le partage de la vue',
};

export function openPageHistory(options: HistoryOptions): () => void {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-desktop-settings-overlay', '');
  const surface = document.createElement('section');
  surface.setAttribute('data-navigation-dialog', '');
  surface.setAttribute('data-desktop-history', '');
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.setAttribute('data-navigation-close', '');
  closeButton.setAttribute('aria-label', 'Fermer');
  closeButton.innerHTML = IconCross;
  const heading = document.createElement('h2');
  heading.setAttribute('data-navigation-heading', '');
  heading.textContent = 'Historique de ' + options.title;
  const versions = document.createElement('select');
  versions.setAttribute('aria-label', 'Version à consulter');
  const preview = document.createElement('article');
  preview.setAttribute('aria-label', 'Aperçu de la version');
  preview.setAttribute('data-history-preview', '');
  const notice = document.createElement('p');
  notice.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.setAttribute('data-history-actions', '');
  const changes = document.createElement('div');
  const points: Version[] = [];
  surface.append(closeButton, heading, versions, preview, changes, actions, notice);
  overlay.append(surface);
  const abort = new AbortController();
  let turn = 0;
  const modal = openModalDialog({
    content: overlay,
    surface,
    label: heading.textContent,
    initialFocus: () => closeButton,
    onDismiss: () => modal.close(),
    onClose: () => {
      turn++;
      abort.abort();
    },
  });
  closeButton.onclick = () => modal.close();
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await options.ticket();
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + token);
    const res = await fetch(options.base + path, {
      ...init,
      headers,
      signal: abort.signal,
      credentials: 'omit',
    });
    if (!res.ok) {
      const message =
        res.status === 412
          ? 'La page a changé. Ouvrez à nouveau la version avant de la restaurer.'
          : res.status === 403
            ? 'Vous n’avez plus accès à cette action.'
            : 'L’historique est indisponible.';
      throw new Error(message);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
  function error(problem: unknown, id: number) {
    if (!abort.signal.aborted && turn === id)
      notice.textContent = problem instanceof Error ? problem.message : 'Impossible de charger cette version.';
  }
  async function selectVersion() {
    const id = ++turn;
    preview.replaceChildren();
    changes.replaceChildren();
    actions.replaceChildren();
    notice.textContent = 'Chargement…';
    const path = '/' + versions.value;
    try {
      const content = await request<Parameters<typeof blocksToHtml>[0]>(path);
      if (turn !== id || abort.signal.aborted) return;
      // The shared read-only renderer sanitizes block HTML and links.
      preview.innerHTML = blocksToHtml(content);
      const selected = points[versions.selectedIndex];
      const older = points[versions.selectedIndex + 1];
      if (selected && selected.sequence > 0) {
        changes.append(historyChangeDetails(request, selected.lineage, selected.sequence,
          older?.lineage === selected.lineage ? older.sequence : 0));
      }
      notice.textContent = '';
      if (!options.editable() || versions.selectedIndex === 0) return;
      const planned = await request<Preview>(path + '/restore/preview', { method: 'POST' });
      if (turn !== id || abort.signal.aborted || !options.editable()) return;
      if (!planned.fits) {
        notice.textContent = 'Cette version est trop volumineuse pour être restaurée.';
        return;
      }
      const approvals = new Map<string, HTMLInputElement>();
      for (const { kind, blockId } of planned.guards) {
        const check = document.createElement('input');
        check.type = 'checkbox';
        const label = document.createElement('label');
        label.append(check, ' ' + (guardLabels[kind] ?? kind) + ' · ' + blockId);
        actions.append(label);
        approvals.set(kind + ':' + blockId, check);
      }
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = 'Restaurer cette version';
      actions.append(restore);
      const key = crypto.randomUUID();
      restore.onclick = async () => {
        if (!options.editable() || turn !== id) return;
        if ([...approvals.values()].some((check) => !check.checked)) {
          notice.textContent = 'Confirmez les changements indiqués.';
          return;
        }
        restore.disabled = true;
        try {
          await options.flush();
          if (abort.signal.aborted || turn !== id || !options.editable()) return;
          await request(path + '/restore', {
            method: 'POST',
            headers: {
              'Blok-Idempotency-Key': key,
              'If-Match': '"' + planned.expectRevision + '"',
              'X-Blok-Restore-Confirm': planned.guards.map((g) => g.kind).join(','),
            },
          });
          if (turn === id) modal.close();
        } catch (problem) {
          error(problem, id);
          restore.disabled = false;
        }
      };
    } catch (problem) {
      error(problem, id);
    }
  }
  versions.onchange = () => {
    void selectVersion();
  };
  notice.textContent = 'Chargement…';
  void (async () => {
    try {
      await options.flush();
      const list = await request<{ versions: Version[] }>('');
      if (abort.signal.aborted) return;
      points.push(...list.versions);
      for (const [index, version] of list.versions.entries()) {
        const option = document.createElement('option');
        option.value = encodeURIComponent(version.lineage) + '/' + version.sequence;
        const date =
          version.savedAt === null
            ? ''
            : ' · ' +
              new Intl.DateTimeFormat('fr', { dateStyle: 'short', timeStyle: 'short' }).format(version.savedAt);
        option.textContent =
          (index === 0
            ? 'Version actuelle'
            : version.sequence === 0
              ? 'Version initiale'
              : 'Version ' + version.sequence) + date;
        versions.append(option);
      }
      if (versions.options.length) await selectVersion();
      else notice.textContent = 'Aucune version enregistrée.';
    } catch (problem) {
      error(problem, turn);
    }
  })();
  return () => modal.close();
}
