import { HTTPException } from 'hono/http-exception';
import type { PoolClient } from 'pg';

const fields = `name,signup_policy AS "signupPolicy",signup_domains AS "signupDomains",
  workspace_creation AS "workspaceCreation",default_workspace_id AS "defaultWorkspaceId",
  setup_completed_at AS "setupCompletedAt",updated_at AS "updatedAt"`;
type Db = Pick<PoolClient, 'query'>;

export async function readInstanceSettings(db: Db) {
  return (await db.query('SELECT ' + fields + ' FROM instance_settings WHERE id')).rows[0];
}

export async function updateInstanceSettings(db: Db, patch: Record<string, unknown>, actor: string | null) {
  const invalid = (message: string): never => {
    throw new HTTPException(400, { message });
  };
  const name = typeof patch.name === 'string' ? patch.name.trim() : undefined;
  if (patch.name !== undefined && (!name || Buffer.byteLength(name) > 120)) invalid('Invalid name');
  if (
    patch.signupPolicy !== undefined &&
    (typeof patch.signupPolicy !== 'string' || !['invite', 'open', 'domain'].includes(patch.signupPolicy))
  )
    invalid('Invalid signupPolicy');
  if (
    patch.workspaceCreation !== undefined &&
    (typeof patch.workspaceCreation !== 'string' ||
      !['anyone', 'admins_only', 'disabled'].includes(patch.workspaceCreation))
  )
    invalid('Invalid workspaceCreation');
  if (
    patch.signupDomains !== undefined &&
    (!Array.isArray(patch.signupDomains) || patch.signupDomains.some((d) => typeof d !== 'string'))
  )
    invalid('Invalid signupDomains');
  const target = patch.defaultWorkspaceId;
  if (
    target != null &&
    (typeof target !== 'string' ||
      !(await db.query('SELECT 1 FROM workspaces WHERE id=$1', [target])).rowCount)
  )
    invalid('Unknown defaultWorkspaceId');
  return (
    await db.query(
      `UPDATE instance_settings SET name=coalesce($1,name),signup_policy=coalesce($2,signup_policy),
      signup_domains=coalesce($3,signup_domains),workspace_creation=coalesce($4,workspace_creation),
      default_workspace_id=CASE WHEN $5 THEN $6 ELSE default_workspace_id END,updated_at=now(),updated_by=$7
      WHERE id RETURNING ` + fields,
      [
        name,
        patch.signupPolicy,
        patch.signupDomains,
        patch.workspaceCreation,
        'defaultWorkspaceId' in patch,
        target,
        actor,
      ],
    )
  ).rows[0];
}
