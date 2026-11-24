import type { CollaborationStatusChangedPayload } from '@bloklabs/core/full';

type DocumentStatus = Pick<CollaborationStatusChangedPayload, 'status' | 'error' | 'save'>;

interface SyncNotice {
  state: 'connecting' | 'connected' | 'pending' | 'offline' | 'unconfirmed' | 'denied' | 'error';
  message: string;
}

export function documentSyncStatus(event: DocumentStatus | undefined, metadataPending: boolean): SyncNotice {
  const save = event?.save;
  if (save?.state === 'blocked' || save?.state === 'quarantined') {
    return { state: 'error', message: 'Certaines modifications n’ont pas été enregistrées. Copiez-les avant de quitter cette page.' };
  }
  if (event?.status === 'error') {
    if (event.error === 'unauthorized' || event.error === 'forbidden') {
      return { state: 'denied', message: 'La session n’a plus accès à cette page. Vérifiez votre connexion au compte et vos droits.' };
    }
    return { state: 'error', message: 'Synchronisation interrompue. Copiez vos dernières modifications avant de rouvrir la page.' };
  }
  const pending = metadataPending || save?.state === 'pending';
  if (event?.status === 'offline') {
    return { state: 'offline', message: pending
      ? 'Hors connexion · Modifications en attente. Gardez cette page ouverte.'
      : 'Hors connexion · Reconnexion automatique…' };
  }
  if (pending) return { state: 'pending', message: 'Modifications en attente d’enregistrement…' };
  if (event?.status !== 'connected') return { state: 'connecting', message: 'Connexion au serveur…' };
  if (save?.state !== 'saved') {
    return { state: 'unconfirmed', message: 'Connexion établie · Enregistrement non confirmé.' };
  }
  return { state: 'connected', message: 'Page synchronisée' };
}
