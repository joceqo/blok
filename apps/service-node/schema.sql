-- Bootstrap only for local reading until apps/service/schema.sql is vendored here.
-- Production parity: ship the same file Go runs, under pg_advisory_xact_lock(774839102).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;

CREATE TABLE IF NOT EXISTS auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Migrate bootstrap tables that still use email as the primary key.
ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS id uuid;
UPDATE auth_challenges SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE auth_challenges ALTER COLUMN id SET DEFAULT gen_random_uuid();
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'auth_challenges'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (email)'
  ) THEN
    ALTER TABLE auth_challenges DROP CONSTRAINT auth_challenges_pkey;
    ALTER TABLE auth_challenges ALTER COLUMN id SET NOT NULL;
    ALTER TABLE auth_challenges ADD PRIMARY KEY (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS auth_challenges_email_idx ON auth_challenges (email);
CREATE INDEX IF NOT EXISTS auth_challenges_email_created_at_idx ON auth_challenges (email, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions (token_hash);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug varchar(128) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role varchar(32) NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_id_idx ON workspace_members (user_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  role varchar(32) NOT NULL,
  invited_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);

CREATE TABLE IF NOT EXISTS pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  title text NOT NULL,
  parent_id uuid REFERENCES pages (id) ON DELETE SET NULL,
  trashed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pages_workspace_id_idx ON pages (workspace_id);
CREATE INDEX IF NOT EXISTS pages_parent_id_idx ON pages (parent_id);

CREATE TABLE IF NOT EXISTS page_documents (
  page_id uuid PRIMARY KEY REFERENCES pages (id) ON DELETE CASCADE,
  doc_id text NOT NULL,
  lineage text,
  sequence bigint
);

CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  byte_size bigint NOT NULL,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_presets_workspace_id_idx ON workspace_presets (workspace_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces (id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES users (id),
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_workspace_id_idx ON audit_events (workspace_id);
CREATE INDEX IF NOT EXISTS audit_events_user_id_idx ON audit_events (user_id);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events (created_at);

CREATE TABLE IF NOT EXISTS teamspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS teamspaces_workspace_id_idx ON teamspaces (workspace_id);

CREATE TABLE IF NOT EXISTS teamspace_members (
  teamspace_id uuid NOT NULL REFERENCES teamspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (teamspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS teamspace_members_user_id_idx ON teamspace_members (user_id);