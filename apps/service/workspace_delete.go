package cloud

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	blokserver "github.com/JackUait/blok/packages/server/go/v2/blokserver"
	"github.com/jackc/pgx/v5"
)

// No workspace FK: this receipt survives logical deletion so journal/file
// cleanup can be retried by exact ID without retaining any content or members.
type workspaceDeletion struct {
	Documents []string
	Assets    []string
}

func (s *Service) deleteAdminWorkspace(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireInstanceAdmin(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		problem(w, 503, "Database unavailable")
		return
	}
	defer tx.Rollback(ctx)
	// Settings first: updates of the default workspace take the same lock order.
	if _, err = tx.Exec(ctx, `SELECT id FROM instance_settings FOR UPDATE`); err != nil {
		problem(w, 503, "Database unavailable")
		return
	}
	var administrator string
	if err = tx.QueryRow(ctx, `SELECT user_id FROM instance_admins WHERE user_id=$1 FOR SHARE`, actor.ID).Scan(&administrator); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			problem(w, 403, "Instance administrator required")
		} else {
			problem(w, 503, "Database unavailable")
		}
		return
	}
	var slug string
	err = tx.QueryRow(ctx, `SELECT slug FROM workspaces WHERE id=$1 FOR UPDATE`, id).Scan(&slug)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		problem(w, 503, "Database unavailable")
		return
	}
	if err == nil {
		// Capture identifiers before removing foreign-key rows. The transaction is
		// all-or-nothing even for a nonempty workspace or its last administrator.
		_, err = tx.Exec(ctx, `INSERT INTO workspace_deletions(workspace_id,slug,document_ids,asset_names)
   SELECT $1,$2,COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM pages WHERE workspace_id=$1),'[]'::jsonb),
   COALESCE((SELECT jsonb_agg(name ORDER BY name) FROM assets WHERE workspace_id=$1),'[]'::jsonb)`, id, slug)
		if err != nil {
			problem(w, 503, "Could not prepare workspace deletion")
			return
		}
		for _, statement := range []string{
			`UPDATE instance_settings SET default_workspace_id=NULL WHERE default_workspace_id=$1`,
			`DELETE FROM row_body_migrations WHERE workspace_id=$1`,
			`DELETE FROM page_shares WHERE page_id IN (SELECT id FROM pages WHERE workspace_id=$1)`,
			`DELETE FROM assets WHERE workspace_id=$1`,
			`DELETE FROM workspace_emojis WHERE workspace_id=$1`,
			`DELETE FROM pages WHERE workspace_id=$1`,
			`DELETE FROM teamspace_memberships WHERE workspace_id=$1`,
			`DELETE FROM teamspaces WHERE workspace_id=$1`,
			`DELETE FROM invites WHERE workspace_id=$1`,
			`DELETE FROM join_requests WHERE workspace_id=$1`,
			`DELETE FROM memberships WHERE workspace_id=$1`,
			`DELETE FROM ai_credentials WHERE scope='workspace' AND owner_id=$1`,
			`DELETE FROM workspaces WHERE id=$1`,
		} {
			if _, err = tx.Exec(ctx, statement, id); err != nil {
				slog.ErrorContext(ctx, "workspace deletion rolled back", "workspace_id", id, "error", err)
				problem(w, 503, "Could not delete workspace")
				return
			}
		}
	}
	var pending workspaceDeletion
	err = tx.QueryRow(ctx, `SELECT document_ids,asset_names FROM workspace_deletions WHERE workspace_id=$1 FOR UPDATE`, id).Scan(&pending.Documents, &pending.Assets)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, 404, "Workspace not found; use its exact ID")
		return
	}
	if err != nil {
		problem(w, 503, "Could not load workspace cleanup")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		problem(w, 503, "Could not commit workspace deletion")
		return
	}
	// Access checks now fail immediately, including existing MCP handles. Purge
	// also closes live sockets and removes the journal/working set on this host.
	if err = s.refreshSettings(ctx); err == nil {
		err = s.cleanDeletedWorkspace(ctx, id, pending)
	}
	if err != nil {
		slog.ErrorContext(ctx, "workspace deleted; cleanup pending", "workspace_id", id, "error", err)
		jsonOut(w, 503, map[string]any{"error": "Workspace deleted; cleanup pending. Retry blok_delete_workspace with the same workspaceId.", "workspaceId": id, "deleted": true, "cleanupComplete": false, "retry": true})
		return
	}
	jsonOut(w, 200, map[string]any{"id": id, "deleted": true, "cleanupComplete": true})
}

func (s *Service) cleanDeletedWorkspace(ctx context.Context, id string, pending workspaceDeletion) error {
	for _, document := range pending.Documents {
		outcome, err := s.Blok.PurgeDocument(ctx, document, func(context.Context) (bool, error) { return true, nil })
		if err != nil {
			return err
		}
		if outcome != blokserver.Purged {
			return fmt.Errorf("document %s is open on another host; retry cleanup there", document)
		}
		if _, err = s.DB.Exec(ctx, `UPDATE workspace_deletions SET document_ids=document_ids-$2::text WHERE workspace_id=$1`, id, document); err != nil {
			return err
		}
	}
	for _, name := range pending.Assets {
		if filepath.Base(name) != name || name == "." || name == ".." {
			return fmt.Errorf("invalid asset filename")
		}
		err := os.Remove(filepath.Join(s.Config.DataDirectory, "uploads", name))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if _, err = s.DB.Exec(ctx, `UPDATE workspace_deletions SET asset_names=asset_names-$2::text WHERE workspace_id=$1`, id, name); err != nil {
			return err
		}
	}
	_, err := s.DB.Exec(ctx, `UPDATE workspace_deletions SET completed_at=COALESCE(completed_at,now()) WHERE workspace_id=$1 AND document_ids='[]'::jsonb AND asset_names='[]'::jsonb`, id)
	return err
}
