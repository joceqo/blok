const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TeamspaceBodyErrorReason = 'invalid_request';

export type ParsedTeamspaceCreateBody =
  | { ok: true; name: string }
  | { ok: false; reason: TeamspaceBodyErrorReason };

export type ParsedTeamspaceMemberAddBody =
  | { ok: true; userId: string }
  | { ok: false; reason: TeamspaceBodyErrorReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTeamspaceCreateBody(value: unknown): ParsedTeamspaceCreateBody {
  if (!isRecord(value)) {
    return { ok: false, reason: 'invalid_request' };
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0) {
    return { ok: false, reason: 'invalid_request' };
  }

  return { ok: true, name };
}

export function parseTeamspaceMemberAddBody(value: unknown): ParsedTeamspaceMemberAddBody {
  if (!isRecord(value)) {
    return { ok: false, reason: 'invalid_request' };
  }

  const userId = typeof value.userId === 'string' ? value.userId.trim() : '';
  if (!UUID_RE.test(userId)) {
    return { ok: false, reason: 'invalid_request' };
  }

  return { ok: true, userId };
}

export function serializeTeamspace(row: {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: Date;
}): {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: Date;
} {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    createdAt: row.createdAt,
  };
}