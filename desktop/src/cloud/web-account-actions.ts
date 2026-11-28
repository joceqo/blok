import {forgetWebAccount, type RemoteWorkspace, type WorkspaceRef} from '../workspace-registry';
import {CloudApiError, type CloudClient, type CloudInstance, type CloudSession} from './client';

export type WebAccountAction = 'account' | 'new-workspace' | 'logout';

export function hasWebAccount(workspace: WorkspaceRef, native: boolean): workspace is RemoteWorkspace {
  return !native && workspace.kind === 'remote' && !workspace.embedded && !workspace.device;
}

export function canCreateWorkspace(instance: CloudInstance | null, session: CloudSession): boolean {
  return instance?.workspaceCreation === 'anyone' ||
    (instance?.workspaceCreation === 'admins_only' && session.user.instanceAdmin === true);
}

/** Leave the editor through a fresh gateway document so its old sync listeners do not survive logout. */
export async function leaveForWebAccount(action: WebAccountAction, options: {
  workspace: WorkspaceRef;
  native: boolean;
  client: Pick<CloudClient, 'session' | 'logout'>;
  flush: () => Promise<void>;
  navigate: (url: string) => void;
}): Promise<void> {
  const {workspace, client} = options;
  if (!hasWebAccount(workspace, options.native)) return;
  await options.flush();
  if (action === 'logout') {
    try {
      const session = await client.session();
      if (session.user.id !== workspace.accountId) {
        throw new Error('Le compte actif a changé. Actualisez la page pour retrouver votre compte.');
      }
      await client.logout();
    } catch (error) {
      if (!(error instanceof CloudApiError && error.status === 401)) throw error;
    }
    try { forgetWebAccount(workspace); } catch { /* The server session is already closed when site storage is unavailable. */ }
  }
  const url = new URL('/', location.origin);
  url.searchParams.set('cloud', '1');
  if (action === 'new-workspace') url.searchParams.set('section', 'create-workspace');
  if (action === 'account') url.searchParams.set('section', 'accounts');
  options.navigate(url.href);
}
