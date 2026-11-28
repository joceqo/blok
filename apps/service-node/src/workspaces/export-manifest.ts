import { serializeWorkspacePreset } from './preset-body.ts';
import type { WorkspacePresetConfig } from './preset-config.ts';
import { parseWorkspaceRole } from './membership.ts';

export type WorkspaceExportPage = {
  id: string;
  title: string;
  parentId: string | null;
  trashed: boolean;
  updatedAt: Date;
};

export type WorkspaceExportMember = {
  userId: string;
  email: string;
  role: string;
};

export type WorkspaceExportManifest = {
  workspace: {
    id: string;
    name: string;
    slug: string;
    createdAt: Date;
  };
  members: WorkspaceExportMember[];
  pages: WorkspaceExportPage[];
  presets: ReturnType<typeof serializeWorkspacePreset>[];
};

export type BuildWorkspaceExportManifestInput = {
  workspace: {
    id: string;
    name: string;
    slug: string;
    createdAt: Date;
  };
  members: Array<{ userId: string; email: string; role: string }>;
  pages: WorkspaceExportPage[];
  presets: Array<{
    id: string;
    workspaceId: string;
    name: string;
    config: WorkspacePresetConfig;
    createdAt: Date;
  }>;
};

/** Pure JSON manifest for workspace export (metadata only — no page document bodies). */
export function buildWorkspaceExportManifest(
  input: BuildWorkspaceExportManifestInput,
): WorkspaceExportManifest {
  return {
    workspace: {
      id: input.workspace.id,
      name: input.workspace.name,
      slug: input.workspace.slug,
      createdAt: input.workspace.createdAt,
    },
    members: input.members.map((row) => ({
      userId: row.userId,
      email: row.email,
      role: parseWorkspaceRole(row.role) ?? row.role,
    })),
    pages: input.pages.map((page) => ({
      id: page.id,
      title: page.title,
      parentId: page.parentId,
      trashed: page.trashed,
      updatedAt: page.updatedAt,
    })),
    presets: input.presets.map((row) => serializeWorkspacePreset(row)),
  };
}