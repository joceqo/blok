import { beforeEach, describe, expect, it } from 'vitest';

import { listWorkspaces, pruneWorkspaces, rememberWorkspace } from './workspace-registry';

const remote = (id: string, name: string, workspaceId = 'equipe') => ({
  kind: 'remote' as const, id, name, server: 'http://localhost:8088',
  accountId: 'a1', workspaceId,
});

describe('a workspace the server no longer has', () => {
  beforeEach(() => localStorage.clear());

  /**
   * Reinstalling a server recreates its workspaces with new ids while the slug
   * stays. Nothing ever dropped the old entries, so the switcher filled up with
   * four "Équipe" that open nothing.
   */
  it('is forgotten once the server says which ones it has', () => {
    rememberWorkspace(remote('w-old-1', 'Équipe'));
    rememberWorkspace(remote('w-old-2', 'Équipe'));
    rememberWorkspace(remote('w-live', 'Équipe'));

    pruneWorkspaces('http://localhost:8088', ['w-live']);

    const remotes = listWorkspaces().filter(item => item.kind === 'remote');

    expect(remotes).toHaveLength(1);
    expect(remotes[0].id).toBe('w-live');
  });

  it('leaves other servers and the local workspace alone', () => {
    rememberWorkspace({ kind: 'remote', id: 'w-prod', name: 'Nexenture', server: 'https://blok.example.test', accountId: 'a1', workspaceId: 'nexenture' });
    rememberWorkspace(remote('w-old', 'Équipe'));

    pruneWorkspaces('http://localhost:8088', []);

    const kept = listWorkspaces();

    expect(kept.some(item => item.kind === 'local')).toBe(true);
    expect(kept.filter(item => item.kind === 'remote').map(item => item.id)).toEqual(['w-prod']);
  });
});
