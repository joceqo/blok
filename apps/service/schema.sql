CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY,email text UNIQUE NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS login_codes(email text PRIMARY KEY,digest text NOT NULL,expires_at timestamptz NOT NULL,attempts int NOT NULL DEFAULT 0,sent_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions(id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS workspaces(id text PRIMARY KEY,slug text UNIQUE NOT NULL,name text NOT NULL,revision bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS memberships(workspace_id text REFERENCES workspaces(id),user_id text REFERENCES users(id),role text NOT NULL CHECK(role IN ('admin','member','viewer')),PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS join_requests(id text PRIMARY KEY,workspace_id text REFERENCES workspaces(id),user_id text REFERENCES users(id),message text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS invites(id text PRIMARY KEY,workspace_id text REFERENCES workspaces(id),email text NOT NULL,role text NOT NULL CHECK(role IN ('member','viewer')),status text NOT NULL DEFAULT 'pending',expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS pages(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),metadata jsonb NOT NULL,trashed boolean NOT NULL DEFAULT false,deleted boolean NOT NULL DEFAULT false,content jsonb,version bigint NOT NULL DEFAULT 0,lineage text,sequence numeric(20,0));
CREATE INDEX IF NOT EXISTS pages_workspace ON pages(workspace_id);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS mcp_tokens(id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),label text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),last_used_at timestamptz);
CREATE INDEX IF NOT EXISTS mcp_tokens_user ON mcp_tokens(user_id);
CREATE TABLE IF NOT EXISTS email_rate_limits(key text PRIMARY KEY,window_start timestamptz NOT NULL DEFAULT now(),count int NOT NULL);
CREATE TABLE IF NOT EXISTS assets(name text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),document_id text NOT NULL REFERENCES pages(id),created_at timestamptz NOT NULL DEFAULT now());
-- Unused since instance_admins (§5.1); keep the empty table rather than drop it mid-flight.
CREATE TABLE IF NOT EXISTS bootstrap_markers(name text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE pages ADD COLUMN IF NOT EXISTS admission_started boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ai_credentials(scope text NOT NULL CHECK(scope IN ('personal','workspace')),owner_id text NOT NULL,encrypted_key bytea,model text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(scope,owner_id));
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;

-- Workspace images do not require an existing page (emoji and cover uploads).
ALTER TABLE assets ALTER COLUMN document_id DROP NOT NULL;
CREATE TABLE IF NOT EXISTS workspace_emojis(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),name text NOT NULL,url text NOT NULL,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,name));
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;

-- Permissions par page. La visibilité s'hérite du parent tant qu'elle vaut 'inherit' ;
-- un partage nommé s'ajoute par-dessus. Conception : docs/plans/2026-11-13-page-permissions-design.md
ALTER TABLE pages ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'inherit' CHECK(visibility IN ('inherit','private','workspace'));
-- Compatibilité : ce qui existait reste ouvert à l'espace. Le schéma étant rejoué à
-- chaque démarrage, ce rattrapage se conditionne à sa propre première exécution.
UPDATE pages SET visibility='workspace' WHERE coalesce(metadata->>'parentId','')='' AND visibility='inherit' AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=4);
CREATE TABLE IF NOT EXISTS page_shares(page_id text NOT NULL REFERENCES pages(id),user_id text NOT NULL REFERENCES users(id),level text NOT NULL CHECK(level IN ('view','edit','full')),granted_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(page_id,user_id));
CREATE INDEX IF NOT EXISTS page_shares_user ON page_shares(user_id);
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;

-- Instance self-host : réglages, administrateurs, jeton de setup.
-- Conception : docs/plans/2026-11-14-self-host-product-plan.md
CREATE TABLE IF NOT EXISTS instance_settings(
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  name text NOT NULL DEFAULT 'Blok',
  signup_policy text NOT NULL DEFAULT 'invite'
    CHECK(signup_policy IN ('invite','domain','open')),
  signup_domains text[] NOT NULL DEFAULT '{}',
  workspace_creation text NOT NULL DEFAULT 'admins_only'
    CHECK(workspace_creation IN ('anyone','admins_only','disabled')),
  default_workspace_id text REFERENCES workspaces(id),
  setup_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id));
CREATE TABLE IF NOT EXISTS instance_admins(
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now());
-- Pas de jeton de premier démarrage : l'assistant est ouvert tant que le setup
-- n'est pas fait, comme celui d'AFFiNE. Le DROP rattrape les instances qui ont
-- tourné sur la version intermédiaire qui en frappait un.
DROP TABLE IF EXISTS setup_tokens;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
INSERT INTO instance_settings DEFAULT VALUES ON CONFLICT DO NOTHING;
-- Une instance qui a déjà des membres n'attend pas d'assistant.
UPDATE instance_settings SET setup_completed_at=now()
 WHERE setup_completed_at IS NULL AND EXISTS(SELECT 1 FROM memberships);
-- ...et elle garde les politiques sous lesquelles elle tournait.
-- Le schéma étant rejoué à chaque démarrage, ce rattrapage se conditionne
-- à sa propre première exécution — sinon chaque redémarrage écraserait le
-- choix de l'administrateur.
UPDATE instance_settings SET signup_policy='open', workspace_creation='anyone'
 WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=5)
   AND EXISTS(SELECT 1 FROM memberships);
-- Un espace unique est l'espace par défaut : le client cesse de nommer un slug.
UPDATE instance_settings SET default_workspace_id=(SELECT id FROM workspaces)
 WHERE default_workspace_id IS NULL AND (SELECT count(*) FROM workspaces)=1;
INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;

-- An entry in the directory never grants access to pages. Both sides of
-- membership belong to the same workspace and expire with it.
CREATE TABLE IF NOT EXISTS teamspaces (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS teamspace_members (
  workspace_id text NOT NULL,
  teamspace_id text NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (workspace_id, teamspace_id, user_id),
  FOREIGN KEY (workspace_id, teamspace_id) REFERENCES teamspaces(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS teamspace_members_user ON teamspace_members(workspace_id, user_id);
INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS pages_workspace_id_id ON pages(workspace_id,id);
CREATE TABLE IF NOT EXISTS teamspace_pages (
  workspace_id text NOT NULL,
  teamspace_id text NOT NULL,
  page_id text NOT NULL,
  PRIMARY KEY (workspace_id,teamspace_id,page_id),
  FOREIGN KEY (workspace_id,teamspace_id) REFERENCES teamspaces(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,page_id) REFERENCES pages(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS teamspace_pages_page ON teamspace_pages(workspace_id,page_id);
INSERT INTO schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;

-- Only an explicitly requested permanent deletion schedules erasure.
CREATE TABLE IF NOT EXISTS page_purge_requests (
  page_id text PRIMARY KEY REFERENCES pages(id),
  requested_by text NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS page_purge_due ON page_purge_requests(next_attempt_at) WHERE completed_at IS NULL;
INSERT INTO schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
INSERT INTO schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_notifications (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK(type IN ('join_requested','join_approved','join_rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS workspace_notifications_inbox
  ON workspace_notifications(workspace_id,recipient_id,(read_at IS NULL) DESC,created_at DESC,id DESC);

-- Keep existing pending requests visible when an installation first gains an inbox.
WITH upgrade AS (
  INSERT INTO schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING RETURNING version
)
INSERT INTO workspace_notifications(workspace_id,recipient_id,actor_id,type,created_at)
SELECT j.workspace_id,m.user_id,j.user_id,'join_requested',j.created_at
FROM upgrade CROSS JOIN join_requests j JOIN memberships m ON m.workspace_id=j.workspace_id
WHERE j.status='pending' AND m.role='admin';

-- Events that link to a page follow the page's visibility, including after deletion.
CREATE TABLE IF NOT EXISTS workspace_calendar_events (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  all_day boolean NOT NULL,
  page_id text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workspace_calendar_range ON workspace_calendar_events(workspace_id, all_day, starts_at);
INSERT INTO schema_migrations(version) VALUES(11) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS calendar_google_connections (
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  refresh_secret text NOT NULL,
  access_secret text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,user_id),
  FOREIGN KEY (workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS calendar_google_states (
  digest text PRIMARY KEY,
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false,
  UNIQUE(workspace_id,user_id),
  FOREIGN KEY (workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workspace_calendar_feeds (
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  id uuid NOT NULL,
  label text NOT NULL,
  secret text NOT NULL,
  PRIMARY KEY(workspace_id,user_id,id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS calendar_availability_shares (
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
INSERT INTO schema_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;
