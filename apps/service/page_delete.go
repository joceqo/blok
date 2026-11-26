package cloud

import "net/http"

// Trash a subtree without replacing the caller's (possibly stale or partial)
// workspace index. Keep content, shares and parent links available for restore.
func (s *Service) changePageTrash(w http.ResponseWriter, r *http.Request, u identity, ws Workspace, action string) {
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		problem(w, 503, "Database unavailable")
		return
	}
	defer tx.Rollback(ctx)

	// Index writes, page creation and permission changes take the same lock.
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT revision FROM workspaces WHERE id=$1 FOR UPDATE`, ws.ID).Scan(&revision); err != nil {
		problem(w, 500, "Delete failed")
		return
	}
	levels, parents, err := s.workspaceLevels(ctx, tx, u.ID, ws.ID)
	if err != nil {
		problem(w, 500, "Delete failed")
		return
	}
	pageID := r.PathValue("id")
	if levels[pageID] < levelView {
		problem(w, 404, "Page not found")
		return
	}
	children := make(map[string][]string)
	for id, parent := range parents {
		children[parent] = append(children[parent], id)
	}
	ids := []string{pageID}
	seen := map[string]bool{pageID: true}
	for i := 0; i < len(ids); i++ {
		id := ids[i]
		if levels[id] < levelEdit {
			problem(w, 403, "Edit access to the entire page subtree required")
			return
		}
		for _, child := range children[id] {
			if !seen[child] {
				seen[child] = true
				ids = append(ids, child)
			}
		}
	}
	args := []any{ws.ID, ids, pageID}
	query := `UPDATE pages SET trashed=true, trash_root=$3 WHERE workspace_id=$1 AND id=ANY($2) AND NOT deleted AND NOT trashed`
	if action != "trash" {
		var trashed, parentTrashed bool
		var batch string
		if err = tx.QueryRow(ctx, `SELECT p.trashed, coalesce(parent.trashed,false), coalesce(p.trash_root,'') FROM pages p
			LEFT JOIN pages parent ON parent.id=p.metadata->>'parentId' AND parent.workspace_id=p.workspace_id AND NOT parent.deleted
			WHERE p.id=$1 AND p.workspace_id=$2 AND NOT p.deleted`, pageID, ws.ID).Scan(&trashed, &parentTrashed, &batch); err != nil {
			problem(w, 404, "Page not found")
			return
		}
		if !trashed || (action == "restore" && parentTrashed) {
			problem(w, 409, "Page or parent has changed")
			return
		}
		if action == "restore" {
			query = `UPDATE pages SET trashed=false,trash_root=NULL WHERE workspace_id=$1 AND id=ANY($2) AND trashed AND NOT deleted AND coalesce(trash_root,'')=$3`
			args[2] = batch
		} else {
			var live bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT FROM pages WHERE workspace_id=$1 AND id=ANY($2) AND NOT deleted AND NOT trashed)`, ws.ID, ids).Scan(&live); err != nil || live {
				problem(w, 409, "Subtree contains a live page")
				return
			}
			args = args[:2]
			query = `UPDATE pages SET deleted=true, content=NULL, trash_root=NULL WHERE workspace_id=$1 AND id=ANY($2) AND trashed AND NOT deleted`
		}
	}
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		problem(w, 500, "Delete failed")
		return
	}
	if tag.RowsAffected() > 0 {
		if err = tx.QueryRow(ctx, `UPDATE workspaces SET revision=revision+1 WHERE id=$1 RETURNING revision`, ws.ID).Scan(&revision); err != nil {
			problem(w, 500, "Delete failed")
			return
		}
	}
	if err = tx.Commit(ctx); err != nil {
		problem(w, 500, "Delete failed")
		return
	}
	s.recheckWorkspace(ctx, ws.ID)
	jsonOut(w, 200, map[string]any{"id": r.PathValue("id"), "trashed": action == "trash", "affectedPages": tag.RowsAffected(), "revision": revision})
}
