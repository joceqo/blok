package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
)

// Reparent metadata transactionally; structural pointers use a resumable
// copy-before-remove placement. Descendants keep their IDs and documents.
func (s *Service) movePage(w http.ResponseWriter, r *http.Request, u identity, ws Workspace) {
	var in struct {
		ParentID    json.RawMessage `json:"parentId"`
		ParentRowID *string         `json:"parentRowId,omitempty"`
		TeamspaceID json.RawMessage `json:"teamspaceId,omitempty"`
	}
	if !body(w, r, &in) {
		return
	}
	var parent, requestedTeamspace *string
	if len(in.ParentID) == 0 || json.Unmarshal(in.ParentID, &parent) != nil || (parent != nil && !pageIDPattern.MatchString(*parent)) {
		problem(w, 400, "parentId string or null required")
		return
	}
	if len(in.TeamspaceID) > 0 && (parent != nil || json.Unmarshal(in.TeamspaceID, &requestedTeamspace) != nil || (requestedTeamspace != nil && *requestedTeamspace == "")) {
		problem(w, 400, "teamspaceId is only supported with a null parentId")
		return
	}
	ctx := r.Context()
	requestedParent, requestedRow := "", ""
	if parent != nil {
		requestedParent = *parent
	}
	if in.ParentRowID != nil {
		if *in.ParentRowID == "" || len(*in.ParentRowID) > 256 || parent == nil {
			problem(w, 400, "parentRowId requires its containing parentId")
			return
		}
		requestedRow = *in.ParentRowID
	}
	target, err := s.resolvePlacementTarget(ctx, u, ws.ID, requestedParent, requestedRow)
	if err != nil {
		problem(w, placementStatus(err), err.Error())
		return
	}
	if target.Document != "" {
		parent = &target.Document
	}
	id := r.PathValue("id")
	// Room snapshots can flush projections, which take the workspace lock.
	// Prepare outside that lock, then bind the plan to unchanged metadata below.
	priorPlan, planReadErr := s.loadPlacement(ctx, s.DB, id)
	var preparedPlan *pagePlacement
	var preparedSource string
	var prepareErr error
	if planReadErr == nil && (priorPlan == nil || priorPlan.Complete) {
		granted, e := s.effectiveLevel(ctx, s.DB, u.ID, id)
		if e != nil {
			prepareErr = e
		} else if granted >= levelFull {
			var title string
			e = s.DB.QueryRow(ctx, `SELECT coalesce(metadata->>'parentId',''),coalesce(metadata->>'title','') FROM pages WHERE id=$1 AND workspace_id=$2 AND NOT deleted AND NOT trashed`, id, ws.ID).Scan(&preparedSource, &title)
			if e == nil {
				preparedPlan, prepareErr = s.planPlacement(ctx, u, id, preparedSource, title, target)
			} else {
				prepareErr = e
			}
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		problem(w, 503, "Database unavailable")
		return
	}
	defer tx.Rollback(ctx)
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT revision FROM workspaces WHERE id=$1 FOR UPDATE`, ws.ID).Scan(&revision); err != nil {
		problem(w, 500, "Move failed")
		return
	}
	levels, parents, nodes, err := s.workspaceChains(ctx, tx, u.ID, ws.ID)
	if err != nil {
		problem(w, 500, "Move failed")
		return
	}
	var live bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pages WHERE id=$1 AND workspace_id=$2 AND NOT deleted AND NOT trashed)`, id, ws.ID).Scan(&live); err != nil {
		problem(w, 500, "Move failed")
		return
	}
	if !live || levels[id] < levelView {
		problem(w, 404, "Page not found")
		return
	}
	if levels[id] < levelFull {
		problem(w, 403, "Full access required to move a page")
		return
	}
	var sourceMeta locationMetadata
	var sourceRaw []byte
	if err = tx.QueryRow(ctx, `SELECT metadata FROM pages WHERE id=$1`, id).Scan(&sourceRaw); err != nil || json.Unmarshal(sourceRaw, &sourceMeta) != nil {
		problem(w, 500, "Move failed")
		return
	}
	if sourceMeta.RowBodyOf != nil {
		problem(w, 409, "A row body cannot be detached from its owner row; move its child pages instead")
		return
	}
	children := map[string][]string{}
	for child, p := range parents {
		children[p] = append(children[p], child)
	}
	subtree := []string{id}
	seen := map[string]bool{id: true}
	for i := 0; i < len(subtree); i++ {
		page := subtree[i]
		if levels[page] < levelFull {
			problem(w, 403, "Full access to every descendant required")
			return
		}
		for _, child := range children[page] {
			if seen[child] {
				problem(w, 409, "Invalid page hierarchy")
				return
			}
			seen[child] = true
			subtree = append(subtree, child)
		}
	}
	newParent := ""
	if parent != nil {
		newParent = *parent
		if seen[newParent] {
			problem(w, 409, "Cannot move a page into itself or its descendants")
			return
		}
		if levels[newParent] < levelView {
			problem(w, 404, "Destination not found")
			return
		}
		if levels[newParent] < levelEdit {
			problem(w, 403, "Destination write access required")
			return
		}
		// A direct share can grant access below a hidden ancestor, but a trashed
		// ancestor is never a valid destination for a live page.
		chain := []string{}
		for p := newParent; p != ""; p = parents[p] {
			if len(chain) >= maxPageDepth {
				problem(w, 409, "Invalid destination hierarchy")
				return
			}
			chain = append(chain, p)
		}
		var unavailable bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pages WHERE id=ANY($1) AND (trashed OR deleted))`, chain).Scan(&unavailable); err != nil {
			problem(w, 500, "Move failed")
			return
		}
		if unavailable {
			problem(w, 404, "Destination not found")
			return
		}
	}
	sourceTS, err := s.pageTeamspace(ctx, tx, u.ID, id)
	if err != nil {
		problem(w, 500, "Move failed")
		return
	}
	targetTS := sourceTS
	if parent != nil {
		targetTS, err = s.pageTeamspace(ctx, tx, u.ID, newParent)
		if err != nil {
			problem(w, 500, "Move failed")
			return
		}
	} else if len(in.TeamspaceID) > 0 {
		targetTS = ""
		if requestedTeamspace != nil {
			targetTS = *requestedTeamspace
		}
	}
	if sourceTS != targetTS {
		if sourceTS != "" {
			t, err := s.teamspace(ctx, tx, u.ID, ws.ID, sourceTS)
			if err != nil || !t.CanManage || t.Archived {
				problem(w, 403, "Source teamspace management required")
				return
			}
		}
		if targetTS != "" && !s.teamspaceWritable(ctx, tx, u.ID, ws.ID, targetTS) {
			problem(w, 403, "Destination teamspace write access required")
			return
		}
	}
	var resultTS *string
	if targetTS != "" {
		resultTS = &targetTS
	}
	// Validate the deepest descendant too, so moving a whole branch cannot
	// exceed the permission resolver's depth bound and silently lose access.
	parents[id] = newParent
	for _, page := range subtree {
		visited := map[string]bool{}
		for p := page; p != ""; p = parents[p] {
			if visited[p] || len(visited) >= maxPageDepth {
				problem(w, 409, "Maximum page depth exceeded")
				return
			}
			visited[p] = true
		}
	}
	plan, err := s.loadPlacement(ctx, tx, id)
	if err != nil {
		problem(w, 503, "Could not read pending page placement")
		return
	}
	if plan != nil && !plan.Complete {
		if !samePlacementTarget(plan.Target, target) || plan.Source != sourceMeta.ParentID {
			problem(w, 409, "Another page placement is pending; repeat its original destination first")
			return
		}
	} else {
		if planReadErr != nil {
			problem(w, 503, "Could not read pending page placement")
			return
		}
		if prepareErr != nil {
			problem(w, placementStatus(prepareErr), prepareErr.Error())
			return
		}
		if sourceMeta.ParentID != preparedSource || !samePlacementPlan(priorPlan, plan) {
			attempt, _ := ctx.Value(placementPlanningRetryKey{}).(int)
			if attempt >= 3 {
				problem(w, 409, "Page moved repeatedly while preparing placement; retry")
				return
			}
			if err = tx.Commit(ctx); err != nil {
				problem(w, 503, "Could not restart page placement")
				return
			}
			encoded, _ := json.Marshal(in)
			r.Body = io.NopCloser(bytes.NewReader(encoded))
			s.movePage(w, r.WithContext(context.WithValue(ctx, placementPlanningRetryKey{}, attempt+1)), u, ws)
			return
		}
		plan = preparedPlan
		if plan != nil {
			if err = s.savePlacement(ctx, tx, id, plan); err != nil {
				problem(w, 503, "Could not save page placement")
				return
			}
			if err = tx.Commit(ctx); err != nil {
				problem(w, 503, "Could not save page placement")
				return
			}
			// Re-enter with the now-durable plan. No document edits happened before
			// this commit; repeated calls reuse its pointer and operation IDs.
			encoded, _ := json.Marshal(in)
			r.Body = io.NopCloser(bytes.NewReader(encoded))
			s.movePage(w, r, u, ws)
			return
		}
	}
	if plan == nil && sourceMeta.ParentID == newParent && sourceTS == targetTS {
		jsonOut(w, 200, map[string]any{"id": id, "parentId": parent, "teamspaceId": resultTS, "revision": revision})
		return
	}
	if plan != nil && ctx.Value(placementFinalizingKey{}) != plan.Operation {
		if err = tx.Commit(ctx); err != nil {
			problem(w, 503, "Could not prepare page placement")
			return
		}
		if err = s.executePlacement(ctx, u, ws.ID, id, plan); err != nil {
			jsonOut(w, placementStatus(err), map[string]any{"error": err.Error(), "pageId": id, "operationId": plan.Operation, "parentId": plan.Target.RequestedParent, "parentRowId": plan.Target.RequestedRow, "retry": "Repeat blok_move_page with this pageId and destination"})
			return
		}
		encoded, _ := json.Marshal(in)
		r.Body = io.NopCloser(bytes.NewReader(encoded))
		r = r.WithContext(context.WithValue(ctx, placementFinalizingKey{}, plan.Operation))
		s.movePage(w, r, u, ws)
		return
	}
	visibility := nodes[id].Visibility
	if parent == nil && visibility == visInherit {
		// A detached inherited page needs an explicit root visibility. Keep the
		// former effective visibility instead of publishing private content.
		visibility = visPrivate
		for p := nodes[id].ParentID; p != ""; p = nodes[p].ParentID {
			if nodes[p].Visibility != visInherit {
				visibility = nodes[p].Visibility
				break
			}
		}
	}
	var rootTS *string
	if parent == nil {
		rootTS = resultTS
	}
	if _, err = tx.Exec(ctx, `UPDATE pages SET metadata=metadata || jsonb_build_object('parentId',$3::text,'position',(SELECT coalesce(max((metadata->>'position')::numeric),-1)+1 FROM pages WHERE workspace_id=$2 AND NOT deleted)),teamspace_id=$4,visibility=$5 WHERE id=$1 AND workspace_id=$2`, id, ws.ID, parent, rootTS, visibility); err != nil {
		problem(w, 500, "Move failed")
		return
	}
	// The mover already has full access; retain it when the old parent grant
	// disappears, so they can still access and undo their move.
	if _, err = tx.Exec(ctx, `INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,$2,'full',$2) ON CONFLICT(page_id,user_id) DO UPDATE SET level='full'`, id, u.ID); err != nil {
		problem(w, 500, "Move failed")
		return
	}
	if err = tx.QueryRow(ctx, `UPDATE workspaces SET revision=revision+1 WHERE id=$1 RETURNING revision`, ws.ID).Scan(&revision); err != nil {
		problem(w, 500, "Move failed")
		return
	}
	if plan != nil {
		plan.Complete = true
		plan.Revision = revision
		if _, err = tx.Exec(ctx, `UPDATE page_create_requests SET complete=true,result=jsonb_set(result,'{revision}',to_jsonb($3::bigint)) WHERE page_id=$1 AND operation_id=$2 AND NOT complete`, id, plan.Operation, revision); err != nil {
			problem(w, 503, "Could not save creation receipt")
			return
		}
		if err = s.savePlacement(ctx, tx, id, plan); err != nil {
			problem(w, 503, "Could not finish page placement; repeat the same move")
			return
		}
	}
	if err = tx.Commit(ctx); err != nil {
		problem(w, 500, "Move failed")
		return
	}
	s.recheckWorkspace(ctx, ws.ID)
	jsonOut(w, 200, map[string]any{"id": id, "parentId": parent, "teamspaceId": resultTS, "revision": revision})
}
