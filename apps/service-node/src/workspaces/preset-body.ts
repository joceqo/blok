import {
  parsePresetConfig,
  type WorkspacePresetConfig,
} from './preset-config.ts';

export type PresetBodyErrorReason =
  | 'invalid_request'
  | 'invalid_config'
  | 'invalid_role';

export type ParsedPresetCreateBody =
  | { ok: true; name: string; config: WorkspacePresetConfig }
  | { ok: false; reason: PresetBodyErrorReason };

export type ParsedPresetPatchBody =
  | {
      ok: true;
      updates: { name?: string; config?: WorkspacePresetConfig };
    }
  | { ok: false; reason: PresetBodyErrorReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePresetCreateBody(value: unknown): ParsedPresetCreateBody {
  if (!isRecord(value)) {
    return { ok: false, reason: 'invalid_request' };
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0) {
    return { ok: false, reason: 'invalid_request' };
  }

  const parsed = parsePresetConfig(value.config);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }

  return { ok: true, name, config: parsed.config };
}

export function parsePresetPatchBody(value: unknown): ParsedPresetPatchBody {
  if (!isRecord(value)) {
    return { ok: false, reason: 'invalid_request' };
  }

  const hasName = 'name' in value;
  const hasConfig = 'config' in value;
  if (!hasName && !hasConfig) {
    return { ok: false, reason: 'invalid_request' };
  }

  const updates: { name?: string; config?: WorkspacePresetConfig } = {};

  if (hasName) {
    if (typeof value.name !== 'string' || value.name.trim().length === 0) {
      return { ok: false, reason: 'invalid_request' };
    }
    updates.name = value.name.trim();
  }

  if (hasConfig) {
    const parsed = parsePresetConfig(value.config);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }
    updates.config = parsed.config;
  }

  return { ok: true, updates };
}

export function serializeWorkspacePreset(row: {
  id: string;
  workspaceId: string;
  name: string;
  config: WorkspacePresetConfig;
  createdAt: Date;
}): {
  id: string;
  workspaceId: string;
  name: string;
  config: WorkspacePresetConfig;
  createdAt: Date;
} {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    config: row.config,
    createdAt: row.createdAt,
  };
}