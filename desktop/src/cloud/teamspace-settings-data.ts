import {useCallback, useEffect, useRef, useState} from 'react';
import {CloudApiError, type CloudClient, type CloudRole} from './client';

export type TeamClient = Pick<CloudClient, 'request' | 'workspace'>;
export type TeamRole = 'owner' | 'member';
export interface TeamMember {userId: string; email: string; name?: string; role: TeamRole; workspaceRole: CloudRole}
export interface Team {
  id: string; name: string; description: string; icon: string; isDefault: boolean; memberCount: number;
  joined: boolean; owners: {userId: string; name?: string; email: string}[]; updatedAt: string; canManage: boolean;
}
export interface Directory {teamspaces: Team[]; settings: {restrictCreation: boolean}; canCreate: boolean}

export function teamError(cause: unknown): string {
  if (cause instanceof CloudApiError) {
    if (cause.status === 401) return 'Votre session a expiré. Reconnectez-vous.';
    if (cause.status === 403) return 'Vos droits ne permettent pas cette action.';
    if (cause.status === 404) return 'Cet espace ou ce membre n’est plus accessible.';
    if (cause.message === 'last_owner') return 'Désignez un autre propriétaire avant de retirer le dernier.';
    if (cause.message === 'default_teamspace') return 'Cet espace accueille automatiquement tous les membres.';
    if (cause.message === 'viewer_cannot_own') return 'Une personne en lecture seule ne peut pas devenir propriétaire.';
    if (cause.message === 'already_member') return 'Cette personne fait déjà partie de l’équipe.';
    if (cause.status === 400) return 'Vérifiez les informations saisies.';
  }
  return 'La demande a échoué. Réessayez.';
}

export function useResource<T>(client: TeamClient, path: string, revision = 0) {
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{path: string; value?: T; error?: string}>();
  useEffect(() => {
    const controller = new AbortController();
    void client.request<T>(path, {signal: controller.signal}).then(
      value => {if (!controller.signal.aborted) setResult({path, value});},
      cause => {if (!controller.signal.aborted) setResult({path, error: teamError(cause)});}
    );
    return () => controller.abort();
  }, [client, path, revision, attempt]);
  return {value: result?.path === path ? result.value : undefined, error: result?.path === path ? result.error : undefined,
    reload: useCallback(() => retry(index => index + 1), [])};
}

export function useTeamWrite(client: TeamClient) {
  const running = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => running.current?.abort(), []);
  async function write<T>(path: string, method: string, body: object | undefined, done: (result: T) => void) {
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    setBusy(true); setError('');
    try {
      const result = await client.request<T>(path, {method, signal: controller.signal, body: body && JSON.stringify(body)});
      if (!controller.signal.aborted) done(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(teamError(cause));
    } finally {
      running.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return {write, busy, error};
}
