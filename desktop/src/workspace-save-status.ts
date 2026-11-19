import type { CollaborationStatusChangedPayload } from '../../types/events/editor-events';

const BUSY_DELAY_MS = 1000;

/** Presentation only: remote edits remain in the editor's in-memory queue. */
export function createWorkspaceSaveStatus(remote: boolean, online = navigator.onLine) {
  const element = document.createElement('span');
  element.setAttribute('data-desktop-status', '');
  element.setAttribute('role', 'status');
  element.setAttribute('aria-atomic', 'true');
  element.tabIndex = 0;

  const svgNamespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(svgNamespace, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNamespace, 'path');
  path.setAttribute('d', remote
    ? 'M6.5 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.5 1.5 3.75 3.75 0 1 1 .75 7.5Z'
    : 'M4 5h16v11H4z M8 20h8 M12 16v4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  icon.append(path);

  const statusLabel = document.createElement('span');
  statusLabel.setAttribute('data-desktop-status-label', '');
  element.append(icon, statusLabel);

  const model: {
    connection: CollaborationStatusChangedPayload['status'];
    save?: CollaborationStatusChangedPayload['save'];
    busyTimer?: ReturnType<typeof setTimeout>;
    online: boolean;
    pending: number;
    ready: boolean;
    disposed: boolean;
  } = { connection: 'connecting', online, pending: 0, ready: false, disposed: false };
  const failures = new Map<string, { label: string; detail: string; network: boolean }>();

  const clearBusy = (): void => {
    clearTimeout(model.busyTimer);
    model.busyTimer = undefined;
    element.removeAttribute('data-sync-busy');
  };

  const getPresentation = () => {
    const { connection, save, pending, ready } = model;
    const recordedFailures = [...failures.values()];
    const failure = recordedFailures.find((item) => !item.network) ?? recordedFailures.at(-1);
    if (failure && !failure.network) {
      return { state: 'error', label: failure.label, detail: failure.detail };
    }
    if (remote && (save?.state === 'blocked' || save?.state === 'quarantined' || connection === 'error')) {
      return {
        state: 'error', label: 'Enregistrement interrompu',
        detail: 'Les modifications ne peuvent pas être envoyées. Gardez cette page ouverte et vérifiez votre accès à l’espace.',
      };
    }
    const hasPendingChanges = pending > 0
      || (remote && (save?.state === 'pending' || (save?.pendingOperations ?? 0) > 0 || (save?.pendingBytes ?? 0) > 0));
    if (remote && (!model.online || connection === 'offline' || failure?.network)) {
      const unsaved = hasPendingChanges || failure !== undefined;
      return {
        state: 'offline', label: unsaved ? 'Hors-ligne · non enregistré' : 'Hors-ligne',
        detail: unsaved
          ? 'Des modifications attendent leur enregistrement sur le serveur. Gardez cette page ouverte jusqu’à la fin de la synchronisation.'
          : 'Connexion au serveur interrompue. La reconnexion est automatique.',
      };
    }
    if (hasPendingChanges) {
      return {
        state: 'pending', label: remote ? 'Synchronisation…' : 'Enregistrement…',
        detail: remote ? 'Des modifications attendent leur confirmation par le serveur.' : 'Enregistrement sur cet appareil en cours.',
      };
    }
    if (remote && (connection !== 'connected' || save?.state !== 'saved')) {
      return {
        state: 'connecting', label: connection === 'connected' ? 'Confirmation en attente' : 'Connexion…',
        detail: 'L’enregistrement sur le serveur n’est pas encore confirmé.',
      };
    }
    if (!remote && !ready) {
      return { state: 'loading', label: 'Ouverture…', detail: 'Chargement de la page sur cet appareil.' };
    }
    return {
      state: 'saved', label: remote ? 'Enregistré' : 'Sur cet appareil',
      detail: remote ? 'Toutes les modifications ont été confirmées par le serveur.' : 'Cette page est enregistrée sur cet appareil.',
    };
  };

  const paint = (): void => {
    if (model.disposed) return;
    const { state, label, detail } = getPresentation();
    const alert = state === 'offline' || state === 'error';
    const waiting = state === 'pending' || state === 'connecting' || state === 'loading';

    element.toggleAttribute('data-sync-compact', !alert);
    const live = alert ? 'polite' : 'off';
    if (element.getAttribute('aria-live') !== live) element.setAttribute('aria-live', live);
    if (statusLabel.textContent !== label) statusLabel.textContent = label;
    if (element.title !== detail) element.title = detail;
    const accessibleLabel = `${label}. ${detail}`;
    if (element.getAttribute('aria-label') !== accessibleLabel) element.setAttribute('aria-label', accessibleLabel);
    element.setAttribute('data-sync-state', state);
    element.toggleAttribute('data-error', state === 'error');

    if (!waiting) {
      clearBusy();
    } else if (model.busyTimer === undefined && !element.hasAttribute('data-sync-busy')) {
      model.busyTimer = setTimeout(() => {
        model.busyTimer = undefined;
        element.setAttribute('data-sync-busy', '');
      }, BUSY_DELAY_MS);
    }
  };
  paint();
  return {
    element,
    connection(event?: Partial<CollaborationStatusChangedPayload>) {
      if (event?.status) model.connection = event.status;
      if (event?.save) model.save = event.save;
      // A connection event cannot acknowledge a failed metadata save.
      paint();
    },
    resetPage() {
      clearBusy();
      model.connection = 'connecting';
      model.save = undefined;
      model.ready = false;
      paint();
    },
    ready() { model.ready = true; paint(); },
    online(value: boolean) { model.online = value; paint(); },
    pending(value: number) { model.pending = value; paint(); },
    error(error: unknown, refusal?: string | null, source = 'operation') {
      failures.set(source, {
        label: refusal ? 'Accès refusé' : 'Enregistrement impossible',
        detail: refusal ?? (remote
          ? 'Le serveur n’a pas confirmé l’enregistrement. Gardez cette page ouverte et réessayez après le rétablissement de la connexion.'
          : 'L’enregistrement sur cet appareil a échoué. Gardez cette page ouverte et vérifiez l’espace disponible.'),
        network: remote && !refusal && error instanceof TypeError,
      });
      paint();
    },
    saved(source = 'operation') { failures.delete(source); paint(); },
    dispose() { model.disposed = true; clearBusy(); },
  };
}
