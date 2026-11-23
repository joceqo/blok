import type { CollaborationStatusChangedPayload } from '../../types/events/editor-events';

import type { Saver } from '../../types/api/saver';

import { actionLabel, diagnosticContext, dismissibleAction, failureMetadata, openDiagnostic, syncReport,
  type DiagnosticControl, type Failure } from './save-diagnostic';

interface DiagnosticOptions {
  pageId(): string;
  retry?(source: 'manifest' | 'refresh'): Promise<void>;
}

type QuarantineActions = Pick<Saver, 'inspectQuarantine' | 'clearQuarantine'> & Partial<Pick<Saver, 'retryQuarantineAccess'>>;
const BUSY_DELAY_MS = 1000;

/** Presentation only: remote edits remain in the editor's in-memory queue. */
export function createWorkspaceSaveStatus(remote: boolean, online = navigator.onLine,
  recovery?: () => QuarantineActions | undefined, options?: DiagnosticOptions) {
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

  const review = document.createElement('button');
  review.type = 'button';
  review.textContent = 'Voir';
  review.setAttribute('aria-label', 'Voir les modifications refusées');
  let dialog: HTMLDialogElement | undefined;
  let revision = 0;
  const closeReview = (): void => {
    revision++;
    dialog?.remove();
    dialog = undefined;
    review.disabled = false;
  };

  const model: {
    connection: CollaborationStatusChangedPayload['status'];
    save?: CollaborationStatusChangedPayload['save'];
    busyTimer?: ReturnType<typeof setTimeout>;
    online: boolean;
    pending: number;
    ready: boolean;
    disposed: boolean;
  } = { connection: 'connecting', online, pending: 0, ready: false, disposed: false };
  const failures = new Map<string, { label: string; detail: string; network: boolean; record: Failure }>();
  const recent: Array<Failure & { endedAt: string; outcome: 'confirmed' | 'dismissed' }> = [];
  const keyFor = (source: string, pageId?: string) => JSON.stringify([source,
    ['manifest', 'refresh', 'welcome'].includes(source) ? null : pageId ?? (options?.pageId() || null)]);
  const finishFailure = (key: string, outcome: 'confirmed' | 'dismissed'): void => {
    const entry = failures.get(key);
    if (!entry) return;
    recent.push({ ...entry.record, endedAt: new Date().toISOString(), outcome });
    if (recent.length > 12) recent.shift();
    failures.delete(key);
  };
  const visibleFailures = () => [...failures.values()].filter(({ record }) =>
    record.source !== 'document' || record.pageId === (options?.pageId() || null));
  let socket: Pick<CollaborationStatusChangedPayload, 'error' | 'code' | 'retryInMs'> = {};
  let sequenceObservedAt: string | undefined;
  const diagnostic = () => ({
    ...diagnosticContext(), pageId: options?.pageId() || null, storage: remote ? 'remote' : 'local',
    online: model.online, connection: remote ? model.connection : undefined, ...socket,
    pendingWorkspaceWrites: model.pending, sync: syncReport(model.save, sequenceObservedAt),
    failures: [...failures.values()].map(({ record }) => ({ ...record })), recent: [...recent],
  });
  let diagnosticPanel: HTMLDialogElement | undefined;
  let diagnosticGeneration = 0;
  const inspect = document.createElement('button');
  inspect.type = 'button';
  inspect.setAttribute('data-diagnostic-trigger', '');
  inspect.setAttribute('aria-label', 'Diagnostic de synchronisation');
  const closeDiagnostic = (): void => {
    diagnosticGeneration++;
    diagnosticPanel?.remove();
    diagnosticPanel = undefined;
    inspect.disabled = false;
  };

  const clearBusy = (): void => {
    clearTimeout(model.busyTimer);
    model.busyTimer = undefined;
    element.removeAttribute('data-sync-busy');
  };

  const getPresentation = () => {
    const { connection, save, pending, ready } = model;
    const recordedFailures = visibleFailures();
    const failure = recordedFailures.find((item) => !item.network) ?? recordedFailures.at(-1);
    if (failure && !failure.network) {
      return { state: 'error', label: failure.label, detail: failure.detail };
    }
    if (remote && save?.state === 'quarantined' && save.quarantinedOperations > 0) {
      const n = save.quarantinedOperations;
      return { state: 'error', label: n === 1 ? '1 modification refusée' : `${n} modifications refusées`,
        detail: 'Ces modifications sont conservées sur cet appareil.' };
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
    if (recovery && model.save?.state === 'quarantined' && model.save.quarantinedOperations > 0) {
      if (review.parentElement !== element) element.append(review);
    } else {
      review.remove();
      if (dialog) closeReview();
    }
    if (options) {
      inspect.textContent = alert ? 'Diagnostic' : '';
      if (inspect.parentElement !== element) element.append(inspect);
    }
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
  inspect.onclick = async () => {
    if (inspect.disabled || diagnosticPanel) return;
    inspect.disabled = true;
    const generation = diagnosticGeneration;
    const report = diagnostic();
    const controls: DiagnosticControl[] = [];
    const active = visibleFailures();
    const failure = active.find(item => !item.network) ?? active.at(-1);
    const source = failure?.record.source;
    const failureKey = failure ? keyFor(failure.record.source, failure.record.pageId ?? undefined) : '';
    const stillCurrent = () => generation === diagnosticGeneration && failures.get(failureKey) === failure;
    const retry = options?.retry;
    if (failure && retry && (source === 'manifest' || source === 'refresh')) {
      controls.push({ label: 'Réessayer', run: async () => {
        if (stillCurrent()) await retry(source);
        return failures.has(keyFor(source)) ? 'Le problème persiste. Rouvrez le diagnostic pour voir le dernier état.' : 'Opération confirmée.';
      } });
    } else if (source && failure && dismissibleAction(source)) {
      controls.push({ label: 'Masquer cette alerte', run: () => {
        if (!stillCurrent()) return 'Cette alerte a déjà changé.';
        finishFailure(failureKey, 'dismissed');
        paint();
        return 'Alerte masquée. Vérifiez le résultat de l’action dans la page.';
      } });
    }
    const { label, detail } = getPresentation();
    let quarantine: Record<string, number> | undefined;
    if ((model.save?.quarantinedOperations ?? 0) > 0) {
      try {
        const snapshot = await recovery?.()?.inspectQuarantine(false);
        if (snapshot) {
          quarantine = {};
          for (const { reason, count } of snapshot.entries) {
            const category = ['read-only', 'lineage-mismatch', 'lineage-reset', 'oversized-update', 'stale-lineage', 'stale-format'].includes(reason) ? reason : 'autre';
            quarantine[category] = (quarantine[category] ?? 0) + count;
          }
        }
      } catch { /* Counts from the collaboration event remain available. */ }
    }
    if (generation !== diagnosticGeneration) return;
    diagnosticPanel = openDiagnostic(label + '. ' + detail, { ...report, quarantine }, controls, () => {
      if (generation === diagnosticGeneration) { closeDiagnostic(); inspect.focus(); }
    });
  };
  review.onclick = async () => {
    const actions = recovery?.();
    if (!actions || review.disabled) return;
    const page = revision;
    review.disabled = true;
    try {
      const { through, entries, preview } = await actions.inspectQuarantine();
      if (page !== revision || !review.parentElement || !entries.length) return;
      const panel = document.createElement('dialog');
      dialog = panel;
      panel.setAttribute('data-quarantine-review', '');
      panel.setAttribute('aria-label', 'Modifications refusées');
      const heading = document.createElement('strong');
      heading.textContent = 'Modifications refusées';
      const reasons = document.createElement('ul');
      for (const { reason, count } of entries) {
        const item = document.createElement('li');
        item.textContent = `${count} · ${reason === 'read-only' ? 'Page en lecture seule au moment de l’envoi' : reason}`;
        reasons.append(item);
      }
      const explanation = document.createElement('p');
      explanation.textContent = 'Abandonner supprime définitivement ces modifications de cet appareil.';
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.textContent = 'Conserver';
      keep.autofocus = true;
      keep.onclick = () => panel.close();
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.textContent = 'Abandonner';
      discard.onclick = async () => {
        discard.disabled = true;
        try {
          await actions.clearQuarantine(through);
          if (page === revision) panel.close();
        } catch {
          explanation.textContent = 'Impossible de vider la quarantaine. Vous pouvez réessayer.';
          discard.disabled = false;
        }
      };
      panel.onclose = () => { if (dialog === panel) { closeReview(); review.focus(); } };
      panel.append(heading, reasons);
      if (preview !== undefined) {
        const copy = document.createElement('details');
        const label = document.createElement('summary');
        label.textContent = 'Voir le contenu de la dernière copie locale';
        const blocks = document.createElement('pre');
        blocks.textContent = preview;
        copy.append(label, blocks);
        panel.append(copy);
      }
      if (actions.retryQuarantineAccess && entries.some(entry => entry.reason === 'read-only')) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Revérifier mon accès';
        retry.onclick = () => {
          if (actions.retryQuarantineAccess?.()) {
            retry.disabled = true;
            explanation.textContent = 'Vérification en cours. Les modifications compatibles seront renvoyées si vous avez accès en écriture.';
          } else {
            explanation.textContent = 'La connexion ne permet pas encore de revérifier votre accès. Vos modifications restent en quarantaine.';
          }
        };
        panel.append(retry);
      }
      panel.append(explanation, keep, discard);
      document.body.append(panel);
      panel.showModal();
    } catch {
      if (page === revision) {
        closeReview();
        statusLabel.textContent = 'Impossible de lire les modifications refusées';
      }
    } finally {
      if (page === revision && !dialog) review.disabled = false;
    }
  };
  paint();
  return {
    element,
    diagnostic,
    connection(event?: Partial<CollaborationStatusChangedPayload>) {
      if (event?.status) {
        model.connection = event.status;
        socket = { error: event.error, code: event.code, retryInMs: event.retryInMs };
      }
      if (event?.save && event.save.serverSequence !== model.save?.serverSequence) {
        sequenceObservedAt = event.save.serverSequence === undefined ? undefined : new Date().toISOString();
      }
      if (event?.save) model.save = event.save;
      // A connection event cannot acknowledge a failed metadata save.
      paint();
    },
    resetPage() {
      closeDiagnostic();
      socket = {};
      sequenceObservedAt = undefined;
      closeReview();
      clearBusy();
      model.connection = 'connecting';
      model.save = undefined;
      model.ready = false;
      paint();
    },
    ready() { model.ready = true; paint(); },
    online(value: boolean) { model.online = value; paint(); },
    pending(value: number) { model.pending = value; paint(); },
    error(error: unknown, refusal?: string | null, source = 'operation', pageId?: string) {
      const key = keyFor(source, pageId);
      const previous = failures.get(key)?.record;
      const now = new Date().toISOString();
      const metadata = failureMetadata(error);
      failures.set(key, {
        record: { source, pageId: pageId ?? (options?.pageId() || null), firstAt: previous?.firstAt ?? now,
          lastAt: now, attempts: (previous?.attempts ?? 0) + 1, ...metadata },
        label: actionLabel(source) ?? (refusal ? 'Accès refusé' : 'Enregistrement impossible'),
        detail: refusal ?? (dismissibleAction(source)
          ? 'Vérifiez le résultat de cette action dans la page avant de la relancer.'
          : source === 'refresh' ? 'La liste des pages n’a pas pu être actualisée.'
          : remote
          ? 'Le serveur n’a pas confirmé l’enregistrement. Gardez cette page ouverte et réessayez après le rétablissement de la connexion.'
          : 'L’enregistrement sur cet appareil a échoué. Gardez cette page ouverte et vérifiez l’espace disponible.'),
        network: remote && !refusal && !dismissibleAction(source) && metadata.kind === 'network',
      });
      paint();
    },
    saved(source = 'operation', pageId?: string) { finishFailure(keyFor(source, pageId), 'confirmed'); paint(); },
    dispose() { closeDiagnostic(); closeReview(); model.disposed = true; clearBusy(); },
  };
}
