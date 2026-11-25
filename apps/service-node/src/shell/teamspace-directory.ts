import type { PoolClient } from 'pg';
import type { WorkspaceRole } from '../models/Workspace.ts';

function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function validIcon(icon: unknown): icon is string {
  if (typeof icon !== 'string' || icon.length > 65_536) return false;
  if (icon === '' || /^icon:[a-zA-Z0-9_-]{1,96}(:[a-zA-Z0-9_-]{1,32})?$/.test(icon)) return true;
  if (icon.startsWith('data:image/png;base64,')) {
    const encoded = icon.slice('data:image/png;base64,'.length);
    if (!encoded.startsWith('iVBORw0KGgo') || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    const png = Buffer.from(encoded, 'base64');
    if (png.length < 45 || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
      || png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND') return false;
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    return width > 0 && width <= 96 && height > 0 && height <= 96;
  }
  return icon.length <= 48 && !/[\p{Cc}]/u.test(icon) && /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(icon)
    && [...graphemes.segment(icon)].length === 1;
}

export function teamspaceMetadata(input: unknown) {
  if (!record(input)) return;
  const { name, description, icon } = input;
  if (name === undefined && description === undefined && icon === undefined) return;
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200 || name.includes('\0'))) return;
  if (description !== undefined && (typeof description !== 'string' || description.length > 2000 || description.includes('\0'))) return;
  if (icon !== undefined && !validIcon(icon)) return;
  return { name: name?.trim(), description: description?.trim(), icon };
}

export function teamspaceSettings(input: unknown) {
  if (!record(input)) return;
  const { restrictCreation, defaultTeamspaceIds } = input;
  if (restrictCreation === undefined && defaultTeamspaceIds === undefined) return;
  if (restrictCreation !== undefined && typeof restrictCreation !== 'boolean') return;
  if (defaultTeamspaceIds !== undefined && (!Array.isArray(defaultTeamspaceIds) || defaultTeamspaceIds.length > 1000
    || !defaultTeamspaceIds.every(id => typeof id === 'string' && !!id.trim() && !id.includes('\0') && id.length <= 200))) return;
  return { restrictCreation, defaultTeamspaceIds: defaultTeamspaceIds && [...new Set<string>(defaultTeamspaceIds)] };
}

// Legacy directory entries keep their workspace editing permissions. For new teams
// only the team owners and workspace admins can change membership or metadata.
export const manageTeam = `($3::text='admin' OR ($3='member' AND (NOT t.owner_managed OR EXISTS (
  SELECT 1 FROM teamspace_members own WHERE own.workspace_id=t.workspace_id AND own.teamspace_id=t.id
    AND own.user_id=$2 AND own.role='owner'))))`;

export async function teamspaceDirectory(client: PoolClient, workspaceId: string, userId: string, role: WorkspaceRole, teamId?: string) {
  const { rows } = await client.query(
    `SELECT t.id,t.workspace_id AS "workspaceId",t.name,t.description,t.icon,t.created_at AS "createdAt",
       t.updated_at AS "updatedAt",t.is_default AS "isDefault",${manageTeam} AS "canManage",
       summary.count AS "memberCount",coalesce(summary.joined,false) AS joined,coalesce(summary.owners,'[]') AS owners
     FROM teamspaces t CROSS JOIN LATERAL (
       SELECT count(*)::int AS count, bool_or(m.user_id=$2) AS joined,
         json_agg(json_build_object('userId',u.id,'email',u.email,'name',u.name) ORDER BY u.name,u.email,u.id)
           FILTER (WHERE m.role='owner') AS owners
       FROM teamspace_members m JOIN users u ON u.id=m.user_id
       WHERE m.workspace_id=t.workspace_id AND m.teamspace_id=t.id
     ) summary WHERE t.workspace_id=$1 AND ($4::text IS NULL OR t.id=$4) ORDER BY t.created_at,t.id`,
    [workspaceId, userId, role, teamId ?? null]);
  return rows;
}

export async function enrollWorkspaceMembers(client: PoolClient, workspaceId: string, defaultIds: string[]) {
  await client.query(
    `INSERT INTO teamspace_members(workspace_id,teamspace_id,user_id)
     SELECT m.workspace_id,t.id,m.user_id FROM memberships m JOIN teamspaces t ON t.workspace_id=m.workspace_id
     WHERE m.workspace_id=$1 AND t.id=ANY($2::text[]) AND t.is_default ON CONFLICT DO NOTHING`,
    [workspaceId, defaultIds]);
}
