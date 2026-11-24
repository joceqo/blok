const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TeamspaceBodyErrorReason = 'invalid_request';

export type ParsedTeamspaceCreateBody =
  | { ok: true; name: string }
  | { ok: false; reason: TeamspaceBodyErrorReason };

export type ParsedTeamspaceMemberAddBody =
  | { ok: true; userId: string }
  | { ok: false; reason: TeamspaceBodyErrorReason };

export type ParsedTeamspacePatchBody =
  | { ok: true; name: string }
  | { ok: false; reason: TeamspaceBodyErrorReason };

export type ParsedTeamspaceMemberUserIdParam =
  | { ok: true; userId: string }
  | { ok: false; reason: TeamspaceBodyErrorReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNonBlankName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  return name.length > 0 ? name : undefined;
}

export function parseTeamspaceCreateBody(value: unknown): ParsedTeamspaceCreateBody {
  const name = parseNonBlankName(value);
  if (name === undefined) {
    return { ok: false, reason: 'invalid_request' };
  }
  return { ok: true, name };
}

export function parseTeamspacePatchBody(value: unknown): ParsedTeamspacePatchBody {
  const name = parseNonBlankName(value);
  if (name === undefined) {
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

export function parseTeamspaceMemberUserIdParam(userId: string): ParsedTeamspaceMemberUserIdParam {
  const trimmed = userId.trim();
  if (!UUID_RE.test(trimmed)) {
    return { ok: false, reason: 'invalid_request' };
  }
  return { ok: true, userId: trimmed };
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