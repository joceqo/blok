import type { ShellPage, SidebarMoveTarget, SidebarTeamspace } from '@blok/sidebar';

export type MoveDestination = SidebarMoveTarget & { title: string; path: string; icon?: string };

/** Re-evaluated when a destination is chosen: permissions can change while open. */
export function moveDestinations(options: {
  pages: ShellPage[];
  sourceId: string;
  rootLabel: string;
  canMove: (id: string) => boolean;
  canEdit: (id: string) => boolean;
  teamspaceOf: (id: string) => string | null;
  teamspaces?: (SidebarTeamspace & { canManage?: boolean })[];
  isSharedRoot?: (id: string) => boolean;
}): MoveDestination[] {
  const source = options.pages.find(page => page.id === options.sourceId);
  if (!source) return [];
  const subtree = new Set([source.id]);
  let previous = 0;
  while (previous !== subtree.size) {
    previous = subtree.size;
    options.pages.forEach(page => { if (page.parentId && subtree.has(page.parentId)) subtree.add(page.id); });
  }
  if ([...subtree].some(id => !options.canMove(id))) return [];
  const teamspace = options.teamspaceOf(source.id);
  const teams = new Map(options.teamspaces?.map(team => [team.id, team]));
  const canLeave = !teamspace || teams.get(teamspace)?.canManage === true;
  const byId = new Map(options.pages.map(page => [page.id, page]));
  const destinations: MoveDestination[] = [];
  const atRoot = source.parentId === null && !options.isSharedRoot?.(source.id);
  if (canLeave && (teamspace || !atRoot)) {
    destinations.push({ parentId: null, title: options.rootLabel,
      ...(teamspace ? { teamspaceId: null } : {}), path: 'À la racine de l’espace de travail' });
  }
  for (const team of teams.values()) {
    if (!team.canCreate) continue;
    if (team.id === teamspace ? atRoot : !canLeave) continue;
    destinations.push({ parentId: null, teamspaceId: team.id, title: team.name, icon: team.icon ?? undefined, path: 'Espace d’équipe' });
  }
  for (const page of options.pages) {
    const targetTeam = options.teamspaceOf(page.id);
    if (subtree.has(page.id) || page.id === source.parentId || !options.canEdit(page.id)) continue;
    if (targetTeam !== teamspace && (!canLeave || (targetTeam && !teams.get(targetTeam)?.canCreate))) continue;
    const ancestors: string[] = [];
    const seen = new Set([page.id]);
    let parent = page.parentId ? byId.get(page.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id); ancestors.unshift(parent.title); parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    destinations.push({ parentId: page.id, title: page.title || 'Nouvelle page', icon: page.icon, path: [teams.get(targetTeam ?? '')?.name ?? options.rootLabel, ...ancestors].join(' / ') });
  }
  return destinations;
}
