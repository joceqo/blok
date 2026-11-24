import type { WorkspaceRole } from '@/permissions.js';
import { parseWorkspaceRole } from '@/workspaces/membership.js';

const ROLE_KEYS = ['read', 'edit'] as const;

export type PresetRoleKey = (typeof ROLE_KEYS)[number];

export type WorkspacePresetConfig = {
  read?: WorkspaceRole;
  edit?: WorkspaceRole;
};

export type ParsedPresetConfig =
  | { ok: true; config: WorkspacePresetConfig }
  | { ok: false; reason: 'invalid_config' | 'invalid_role' };

export function parsePresetConfig(value: unknown): ParsedPresetConfig {
  if (value === undefined) {
    return { ok: true, config: {} };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_config' };
  }

  const record = value as Record<string, unknown>;
  const config: WorkspacePresetConfig = {};

  for (const key of ROLE_KEYS) {
    if (!(key in record)) {
      continue;
    }
    const raw = record[key];
    if (typeof raw !== 'string') {
      return { ok: false, reason: 'invalid_role' };
    }
    const role = parseWorkspaceRole(raw);
    if (role === undefined) {
      return { ok: false, reason: 'invalid_role' };
    }
    config[key] = role;
  }

  return { ok: true, config };
}