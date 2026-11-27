package cloud

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Read the ACL and the document at the same snapshot. A new request rechecks
// access even when the client already listed this page in the export index.
func (s *Service) exportPage(w http.ResponseWriter, r *http.Request, u identity, ws Workspace, id string) {
	ctx := r.Context()
	tx, err := s.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		failed(w, 503, "Database unavailable", err)
		return
	}
	defer tx.Rollback(ctx)
	var role string
	err = tx.QueryRow(ctx, `SELECT m.role FROM memberships m JOIN sessions ss ON ss.user_id=m.user_id
        WHERE m.workspace_id=$1 AND ss.id=$2 AND ss.expires_at>now()`, ws.ID, u.Session).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, 403, "Workspace membership required")
		return
	}
	if err != nil {
		failed(w, 503, "Read failed", err)
		return
	}
	chain, err := s.chainOf(ctx, tx, u.ID, id)
	if err != nil {
		failed(w, 503, "Read failed", err)
		return
	}
	if resolve(role, chain) < levelView || (r.URL.Query().Get("private") != "1" && inheritedVisibility(chain) != visWorkspace) {
		problem(w, 404, "Page not found")
		return
	}
	var doc json.RawMessage
	err = tx.QueryRow(ctx, `SELECT COALESCE(content,'null'::jsonb) FROM pages WHERE id=$1 AND workspace_id=$2 AND NOT trashed AND NOT deleted`, id, ws.ID).Scan(&doc)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, 404, "Page not found")
		return
	}
	if err != nil {
		failed(w, 503, "Read failed", err)
		return
	}
	jsonOut(w, 200, doc)
}
