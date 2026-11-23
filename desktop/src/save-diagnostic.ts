import type { CollaborationStatusChangedPayload } from '../../types/events/editor-events';

const actionLabels: Record<string, string> = {
  move: 'Déplacement non confirmé', duplicate: 'Duplication non confirmée',
  rename: 'Renommage non confirmé', delete: 'Suppression non confirmée',
  history: 'Historique indisponible', create: 'Création non confirmée',
  refresh: 'Actualisation impossible', navigation: 'Ouverture de page interrompue',
  library: 'Bibliothèque indisponible', startup: 'Ouverture de l’espace interrompue',
};

export function actionLabel(source: string): string | undefined { return actionLabels[source]; }
export function dismissibleAction(source: string): boolean {
  return Object.hasOwn(actionLabels, source) && !['refresh', 'startup'].includes(source);
}

export function failureMetadata(error: unknown) {
  const kind = error instanceof TypeError && /^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i.test(error.message)
    ? 'network' : error instanceof TypeError ? 'TypeError' : 'unknown';
  for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth++) {
    const item = error as { status?: unknown; requestId?: unknown; cause?: unknown };
    if (item.status === 0) return { kind: 'network' };
    if (typeof item.status === 'number' && Number.isInteger(item.status) && item.status >= 400 && item.status <= 599) {
      return { kind: 'http', httpStatus: item.status, requestId: typeof item.requestId === 'string' && /^[a-f0-9]{32}$/.test(item.requestId) ? item.requestId : undefined };
    }
    error = item.cause;
  }
  return { kind };
}

const tabId = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('');
const build = new URL(import.meta.url).pathname.match(/\/([\w.-]+-[\w-]{8,}\.js)$/)?.[1] ?? 'inconnu';

export interface Failure {
  kind: string;
  source: string;
  pageId: string | null;
  firstAt: string;
  lastAt: string;
  attempts: number;
  httpStatus?: number;
  requestId?: string;
}

export function diagnosticContext() {
  return { capturedAt: new Date().toISOString(), tabId, build };
}

export function syncReport(save: CollaborationStatusChangedPayload['save'], sequenceObservedAt?: string) {
  if (!save) return undefined;
  const { state, reason, pendingBytes, pendingOperations, quarantinedOperations, serverSequence } = save;
  return { state, reason, pendingBytes, pendingOperations, quarantinedOperations, serverSequence, sequenceObservedAt };
}

export interface DiagnosticControl {
  label: string;
  run: () => Promise<string> | string;
}

export function openDiagnostic(summary: string, report: object, controls: DiagnosticControl[], closed: () => void) {
  const panel = document.createElement('dialog');
  panel.setAttribute('data-save-diagnostic', '');
  panel.setAttribute('aria-label', 'Diagnostic de synchronisation');
  const heading = document.createElement('strong');
  heading.textContent = 'Diagnostic de synchronisation';
  const guidance = document.createElement('p');
  guidance.textContent = summary;
  const details = document.createElement('details');
  const label = document.createElement('summary');
  label.textContent = 'Données à partager';
  const json = JSON.stringify(report, null, 2);
  const raw = document.createElement('textarea');
  raw.readOnly = true;
  raw.setAttribute('aria-label', 'Rapport de diagnostic');
  raw.value = json;
  details.append(label, raw);
  const feedback = document.createElement('p');
  feedback.setAttribute('role', 'status');
  const buttons = document.createElement('div');
  const button = (title: string): HTMLButtonElement => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = title;
    buttons.append(el);
    return el;
  };
  for (const control of controls) {
    const el = button(control.label);
    el.onclick = async () => {
      el.disabled = true;
      try { feedback.textContent = await control.run(); }
      catch { feedback.textContent = 'Échec de la tentative. Rouvrez le diagnostic pour voir le dernier état.'; }
    };
  }
  button('Copier le diagnostic').onclick = async () => {
    try { await navigator.clipboard.writeText(json); feedback.textContent = 'Diagnostic copié.'; }
    catch { details.open = true; raw.focus(); raw.select(); feedback.textContent = 'Copiez le texte sélectionné.'; }
  };
  button('Fermer').onclick = () => panel.close();
  panel.onclose = () => { panel.remove(); closed(); };
  panel.append(heading, guidance, details, feedback, buttons);
  document.body.append(panel);
  panel.showModal();
  return panel;
}
