import { PreviewClient } from './shell-story-fixtures';
import type { Team } from '../../desktop/src/cloud/teamspace-settings-data';

export function createTeamspacePreviewClient() {
  const teams = [
    {
      id: 'design',
      name: 'Design',
      description: 'Revues et maquettes',
      icon: 'icon:paint:purple',
      isDefault: false,
      memberCount: 1,
      joined: true,
      owners: [{ userId: 'lou', name: 'Lou', email: '' }],
      updatedAt: '2026-11-20',
      canManage: true,
    },
  ];
  const settings = { restrictCreation: false };
  return new PreviewClient((path, init) => {
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Partial<
            Pick<Team, 'name' | 'description' | 'icon'> & {
              restrictCreation: boolean;
              defaultTeamspaceIds: string[];
            }
          >)
        : {};
    if (path.endsWith('/teamspaces/settings')) {
      if (typeof body.restrictCreation === 'boolean')
        settings.restrictCreation = body.restrictCreation;
      const defaults = body.defaultTeamspaceIds;
      if (!defaults) return { ok: true };
      for (const team of teams) team.isDefault = defaults.includes(team.id);
      return { ok: true };
    }
    if (path.endsWith('/teamspaces')) {
      if (init?.method === 'POST') {
        const team = {
          ...teams[0],
          id: crypto.randomUUID(),
          ...body,
          updatedAt: new Date().toISOString(),
          isDefault: false,
        };
        teams.push(team);
        return { teamspace: team };
      }
      return { teamspaces: teams, settings, canCreate: true };
    }
    if (path.endsWith('/members'))
      return {
        members: [
          {
            id: 'lou',
            userId: 'lou',
            name: 'Lou',
            email: '',
            role: path.includes('/teamspaces/') ? 'owner' : 'admin',
            workspaceRole: 'admin',
          },
        ],
      };
    if (path.endsWith('/pages')) return { pages: [] };
    if (init?.method === 'PATCH') {
      const team = teams.find((item) => path.endsWith('/' + item.id));
      if (team) {
        Object.assign(team, body);
        return { teamspace: team };
      }
    }
    if (init?.method === 'DELETE') {
      const index = teams.findIndex((item) => path.endsWith('/' + item.id));
      if (index >= 0) {
        teams.splice(index, 1);
        return { ok: true };
      }
    }
    throw new Error('Opération indisponible dans cet exemple.');
  });
}
