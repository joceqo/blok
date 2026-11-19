package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

type rowBodyRetryKey string

func nextRowBodyAttempt(ctx context.Context, kind rowBodyRetryKey) (context.Context, error) {
	n, _ := ctx.Value(kind).(int)
	if n >= 3 {
		return ctx, placementRefusal(409, "Document changed repeatedly; preserve the draft and retry")
	}
	return context.WithValue(ctx, kind, n+1), nil
}

type rowBodyResult struct {
	PageID   string `json:"pageId"`
	PublicID string `json:"publicId"`
	ParentID string `json:"parentId"`
	RowID    string `json:"rowId"`
	Revision int64  `json:"revision"`
}
type rowBodyEditPlan struct {
	Operation string           `json:"operation"`
	Head      string           `json:"head"`
	Lineage   string           `json:"lineage"`
	Ops       []map[string]any `json:"ops"`
}

// Opening here is an explicit write intent. Reading/looking up a row never
// allocates a document. Old inline blocks are deliberately not migrated online.
func (s *Service) openRowBody(w http.ResponseWriter, r *http.Request, u identity, ws Workspace) {
	var in struct {
		RowID       string          `json:"rowId"`
		Body        json.RawMessage `json:"body"`
		OperationID string          `json:"operationId"`
	}
	if !body(w, r, &in) {
		return
	}
	if in.RowID == "" || len(in.RowID) > 256 || strings.ContainsRune(in.RowID, 0) {
		problem(w, 400, "rowId required")
		return
	}
	var draft *rowBodyDraft
	if len(in.Body) > 0 {
		if in.OperationID == "" || len(in.OperationID) > 200 || strings.ContainsRune(in.OperationID, 0) {
			problem(w, 400, "A body requires a stable operationId (1–200 characters)")
			return
		}
		var err error
		draft, err = parseRowBodyDraft(in.Body)
		if err != nil {
			problem(w, placementStatus(err), err.Error())
			return
		}
	} else if in.OperationID != "" {
		problem(w, 400, "operationId requires a body")
		return
	}
	document := r.PathValue("id")
	result, err := s.ensureEmptyRowBody(r.Context(), u, ws, document, in.RowID)
	if err == nil && draft != nil {
		err = s.commitRowBodyDraft(r.Context(), u, ws, result, in.OperationID, draft)
	}
	if err != nil {
		details := map[string]any{"error": err.Error(), "parentId": document, "parentRowId": in.RowID}
		if result.PageID != "" {
			details["pageId"] = result.PageID
			details["operationId"] = in.OperationID
			details["retry"] = "Repeat row-body for this document and row; preserve the same operationId and body when sending a draft"
		}
		jsonOut(w, placementStatus(err), details)
		return
	}
	jsonOut(w, 200, result)
}
func emptyRow(state placementSnapshot, rowID string) (placementBlock, placementBlock, error) {
	row, ok := findPlacementBlock(state, rowID)
	if !ok || row.Type != "database-row" {
		return row, placementBlock{}, placementRefusal(404, "Row not found")
	}
	db, ok := findPlacementBlock(state, row.Parent)
	if !ok || db.Type != "database" {
		return row, db, placementRefusal(409, "Invalid row parent")
	}
	seen := map[string]bool{}
	for id := row.ID; id != ""; {
		if seen[id] || len(seen) >= maxPageDepth {
			return row, db, placementRefusal(409, "Invalid row hierarchy")
		}
		seen[id] = true
		block, exists := findPlacementBlock(state, id)
		if !exists {
			return row, db, placementRefusal(409, "Invalid row hierarchy")
		}
		id = block.Parent
	}
	if row.Data["template"] == true {
		return row, db, placementRefusal(409, "Templates cannot acquire separate row bodies")
	}
	properties, _ := row.Data["properties"].(map[string]any)
	for _, value := range properties {
		output, _ := value.(map[string]any)
		if blocks, ok := output["blocks"].([]any); ok && len(blocks) > 0 {
			return row, db, placementRefusal(409, "Legacy row content requires the offline row-body migration")
		}
	}
	for _, id := range row.Content {
		child, found := findPlacementBlock(state, id)
		if !found || child.Type != "database-comment" {
			return row, db, placementRefusal(409, "Inline row content requires the offline row-body migration, including empty paragraphs")
		}
	}
	for _, block := range state.Blocks {
		if block.Parent == row.ID && block.Type != "database-comment" {
			return row, db, placementRefusal(409, "Inline row content requires the offline row-body migration, including empty paragraphs")
		}
	}
	return row, db, nil
}
func rowBodyTitle(row, db placementBlock) string {
	title, _ := row.Data["title"].(string)
	schema, _ := db.Data["schema"].([]any)
	properties, _ := row.Data["properties"].(map[string]any)
	for _, raw := range schema {
		property, ok := raw.(map[string]any)
		if !ok || property["type"] != "title" {
			continue
		}
		id, _ := property["id"].(string)
		if value, ok := properties[id].(string); ok {
			title = value
		}
		break
	}
	if strings.TrimSpace(title) == "" || len(title) > 4096 {
		return "Sans titre"
	}
	return title
}
func rowLinkPlan(state placementSnapshot, row placementBlock, bodyID string) rowBodyEditPlan {
	data := map[string]any{}
	for key, value := range row.Data {
		data[key] = value
	}
	data["pageId"] = bodyID
	data["bodyBlocks"] = true
	return rowBodyEditPlan{Operation: opaque(), Head: state.Head, Lineage: state.Lineage, Ops: []map[string]any{{"op": "update", "id": row.ID, "data": data}}}
}
func (s *Service) existingRowBody(ctx context.Context, u identity, ws Workspace, document, rowID, bodyID string) (rowBodyResult, error) {
	result := rowBodyResult{ParentID: document, RowID: rowID}
	target, err := s.resolvePlacementTarget(ctx, u, ws.ID, document, rowID)
	if err != nil {
		return result, err
	}
	if target.Document != bodyID || bodyID == document || target.Parent != "" {
		return result, placementRefusal(409, "Row body ownership changed")
	}
	result.PageID = bodyID
	if err = s.DB.QueryRow(ctx, `SELECT p.public_id::text,w.revision FROM pages p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1 AND p.workspace_id=$2 AND NOT p.deleted AND NOT p.trashed`, bodyID, ws.ID).Scan(&result.PublicID, &result.Revision); err != nil {
		return result, err
	}
	return result, nil
}
func (s *Service) ensureEmptyRowBody(ctx context.Context, u identity, ws Workspace, document, rowID string) (rowBodyResult, error) {
	result := rowBodyResult{ParentID: document, RowID: rowID}
	if _, err := s.placementDocument(ctx, u, ws.ID, document); err != nil {
		return result, err
	}
	state, err := s.placementState(ctx, u, document)
	if err != nil {
		return result, err
	}
	row, db, err := emptyRow(state, rowID)
	if err != nil {
		return result, err
	}
	if bodyID, _ := row.Data["pageId"].(string); bodyID != "" {
		return s.existingRowBody(ctx, u, ws, document, rowID, bodyID)
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	if err = tx.QueryRow(ctx, `SELECT revision FROM workspaces WHERE id=$1 FOR UPDATE`, ws.ID).Scan(&result.Revision); err != nil {
		return result, err
	}
	var live bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pages WHERE id=$1 AND workspace_id=$2 AND NOT deleted AND NOT trashed)`, document, ws.ID).Scan(&live); err != nil {
		return result, err
	}
	if !live {
		return result, placementRefusal(404, "Page not found")
	}
	granted, err := s.effectiveLevel(ctx, tx, u.ID, document)
	if err != nil {
		return result, err
	}
	if granted < levelEdit {
		return result, placementRefusal(403, "Row write access required")
	}
	chain, err := s.chainOf(ctx, tx, u.ID, document)
	if err != nil {
		return result, err
	}
	if len(chain) >= maxPageDepth {
		return result, placementRefusal(409, "Maximum page depth reached")
	}
	var planRaw []byte
	var complete bool
	err = tx.QueryRow(ctx, `SELECT body_id,plan,complete FROM row_body_creations WHERE document_id=$1 AND row_id=$2`, document, rowID).Scan(&result.PageID, &planRaw, &complete)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if err == nil && complete {
		if err = tx.Commit(ctx); err != nil {
			return result, err
		}
		// Another caller may have completed while our original snapshot was stale.
		return s.existingRowBody(ctx, u, ws, document, rowID, result.PageID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		result.PageID = opaque()
		meta, _ := json.Marshal(map[string]any{"id": result.PageID, "title": rowBodyTitle(row, db), "parentId": document, "rowBodyOf": map[string]any{"documentId": document, "rowId": rowID}})
		if err = tx.QueryRow(ctx, `INSERT INTO pages(id,workspace_id,metadata,content,visibility) VALUES($1,$2,$3,'{"blocks":[]}','inherit') RETURNING public_id::text`, result.PageID, ws.ID, meta).Scan(&result.PublicID); err != nil {
			return result, err
		}
		plan := rowLinkPlan(state, row, result.PageID)
		planRaw, _ = json.Marshal(plan)
		if _, err = tx.Exec(ctx, `INSERT INTO row_body_creations(document_id,row_id,body_id,plan) VALUES($1,$2,$3,$4)`, document, rowID, result.PageID, planRaw); err != nil {
			return result, err
		}
		if err = tx.QueryRow(ctx, `UPDATE workspaces SET revision=revision+1 WHERE id=$1 RETURNING revision`, ws.ID).Scan(&result.Revision); err != nil {
			return result, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	if err = s.linkEmptyRowBody(ctx, u, ws, document, rowID, result.PageID); err != nil {
		return result, err
	}
	return s.existingRowBody(ctx, u, ws, document, rowID, result.PageID)
}
func (s *Service) linkEmptyRowBody(ctx context.Context, u identity, ws Workspace, document, rowID, bodyID string) error {
	// Serialize one row's retries without holding the workspace lock needed by
	// the room's projection handler. The allocation/plan is already durable.
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var raw []byte
	var savedBody string
	if err = tx.QueryRow(ctx, `SELECT body_id,plan FROM row_body_creations WHERE document_id=$1 AND row_id=$2 FOR UPDATE`, document, rowID).Scan(&savedBody, &raw); err != nil {
		return err
	}
	if savedBody != bodyID {
		return placementRefusal(409, "Row body allocation changed")
	}
	var plan rowBodyEditPlan
	if json.Unmarshal(raw, &plan) != nil {
		return errors.New("invalid row body creation plan")
	}
	for attempt := 0; attempt < 3; attempt++ {
		if _, err = s.placementDocument(ctx, u, ws.ID, document); err != nil {
			return err
		}
		bodyMeta, e := s.placementDocument(ctx, u, ws.ID, bodyID)
		if e != nil {
			return e
		}
		if bodyMeta.ParentID != document || bodyMeta.RowBodyOf == nil || bodyMeta.RowBodyOf.DocumentID != document || bodyMeta.RowBodyOf.RowID != rowID {
			return placementRefusal(409, "Row body ownership does not match")
		}
		state, e := s.placementState(ctx, u, document)
		if e != nil {
			return e
		}
		if state.Lineage != plan.Lineage {
			return placementRefusal(409, "Source document lineage changed; review the retained body")
		}
		row, _, e := emptyRow(state, rowID)
		if e != nil {
			return e
		}
		linked, _ := row.Data["pageId"].(string)
		if linked != "" && linked != bodyID {
			return placementRefusal(409, "Row already references another body; retained body requires review")
		}
		if linked == bodyID {
			if e = s.projectPlacementDocument(ctx, u, document); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE row_body_creations SET complete=true WHERE document_id=$1 AND row_id=$2`, document, rowID); e != nil {
				return e
			}
			return tx.Commit(ctx)
		}
		response, e := s.placementHTTP(ctx, u, document, http.MethodPost, "edit", plan.Head, plan.Operation, map[string]any{"ops": plan.Ops})
		if e != nil {
			return e
		}
		if response.Code == 204 {
			// A replayed receipt is not proof that a peer has kept the link.
			current, e := s.placementState(ctx, u, document)
			if e != nil {
				return e
			}
			linkedRow, _, e := emptyRow(current, rowID)
			if e != nil {
				return e
			}
			if current.Lineage != plan.Lineage || linkedRow.Data["pageId"] != bodyID {
				return placementRefusal(409, "Acknowledged row link was removed or changed; review required")
			}
			if e = s.projectPlacementDocument(ctx, u, document); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE row_body_creations SET complete=true WHERE document_id=$1 AND row_id=$2`, document, rowID); e != nil {
				return e
			}
			return tx.Commit(ctx)
		}
		if response.Code != 412 {
			return placementRefusal(response.Code, "Could not attach row body; repeat the same request")
		}
		// The old immutable operation was not applied. Only now may fresh row data
		// and a new operation key be planned, preserving concurrent property edits.
		plan = rowLinkPlan(state, row, bodyID)
		encoded, _ := json.Marshal(plan)
		if _, e = tx.Exec(ctx, `UPDATE row_body_creations SET plan=$3 WHERE document_id=$1 AND row_id=$2`, document, rowID, encoded); e != nil {
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		next, e := nextRowBodyAttempt(ctx, "link")
		if e != nil {
			return e
		}
		return s.linkEmptyRowBody(next, u, ws, document, rowID, bodyID)
	}
	return placementRefusal(409, "Row changed repeatedly; retry without changing the draft")
}

type rowBodyDraft struct {
	Blocks []placementBlock `json:"blocks"`
	Digest string           `json:"-"`
}

func parseRowBodyDraft(raw []byte) (*rowBodyDraft, error) {
	if len(raw) > 512<<10 {
		return nil, placementRefusal(413, "Row draft exceeds 512 KiB")
	}
	var draft rowBodyDraft
	if json.Unmarshal(raw, &draft) != nil || draft.Blocks == nil || len(draft.Blocks) > 2000 {
		return nil, placementRefusal(400, "body must be an OutputData object with at most 2000 blocks")
	}
	ids := map[string]placementBlock{}
	for _, b := range draft.Blocks {
		if b.ID == "" || len(b.ID) > 256 || b.Type == "" || len(b.Type) > 128 || b.Data == nil || strings.ContainsRune(b.ID+b.Type+b.Parent, 0) {
			return nil, placementRefusal(400, "Invalid draft block")
		}
		if _, exists := ids[b.ID]; exists {
			return nil, placementRefusal(400, "Duplicate draft block ID")
		}
		ids[b.ID] = b
		var fields map[string]any
		if json.Unmarshal(b.Original, &fields) != nil {
			return nil, placementRefusal(400, "Invalid draft block")
		}
		if indent, exists := fields["indent"]; exists && indent != float64(0) {
			return nil, placementRefusal(409, "Indented draft blocks cannot yet be committed through this edit port; the draft must be retained")
		}
		for key := range fields {
			switch key {
			case "id", "type", "data", "indent", "parent", "content", "tunes", "lastEditedAt", "lastEditedBy", "lastEditedWith", "createdAt", "createdBy", "createdWith":
			default:
				return nil, placementRefusal(400, "Unsupported draft block field: "+key)
			}
		}
	}
	for _, b := range draft.Blocks {
		seen := map[string]bool{}
		for id := b.ID; id != ""; {
			if seen[id] || len(seen) >= maxPageDepth {
				return nil, placementRefusal(400, "Cyclic or too-deep draft")
			}
			seen[id] = true
			parent, ok := ids[id]
			if !ok {
				return nil, placementRefusal(400, "Missing draft parent")
			}
			id = parent.Parent
		}
		for _, child := range b.Content {
			item, ok := ids[child]
			if !ok || item.Parent != b.ID {
				return nil, placementRefusal(400, "Inconsistent draft children")
			}
		}
	}
	var canonical any
	if json.Unmarshal(raw, &canonical) != nil {
		return nil, placementRefusal(400, "Invalid draft")
	}
	data, _ := json.Marshal(canonical)
	sum := sha256.Sum256(data)
	draft.Digest = hex.EncodeToString(sum[:])
	return &draft, nil
}
func draftInsertPlan(state placementSnapshot, draft *rowBodyDraft) (rowBodyEditPlan, error) {
	plan := rowBodyEditPlan{Operation: opaque(), Head: state.Head, Lineage: state.Lineage, Ops: []map[string]any{}}
	existing := map[string]bool{}
	last := map[string]string{}
	for _, b := range state.Blocks {
		existing[b.ID] = true
		if b.Parent == "" {
			last[""] = b.ID
		}
	}
	for _, b := range draft.Blocks {
		if existing[b.ID] {
			return plan, placementRefusal(409, "Draft block ID already exists in the body; no content was overwritten")
		}
	}
	added := map[string]bool{}
	var add func(placementBlock) error
	add = func(b placementBlock) error {
		if added[b.ID] {
			return nil
		}
		if b.Parent != "" && !added[b.Parent] {
			for _, parent := range draft.Blocks {
				if parent.ID == b.Parent {
					if err := add(parent); err != nil {
						return err
					}
					break
				}
			}
		}
		var block map[string]any
		if err := json.Unmarshal(b.Original, &block); err != nil {
			return err
		}
		delete(block, "parent")
		delete(block, "content")
		delete(block, "indent")
		var parent, after any
		if b.Parent != "" {
			parent = b.Parent
		}
		if last[b.Parent] != "" {
			after = last[b.Parent]
		}
		plan.Ops = append(plan.Ops, map[string]any{"op": "insert", "id": b.ID, "parent": parent, "after": after, "block": block})
		last[b.Parent] = b.ID
		added[b.ID] = true
		return nil
	}
	for _, b := range draft.Blocks {
		if err := add(b); err != nil {
			return plan, err
		}
	}
	return plan, nil
}
func (s *Service) commitRowBodyDraft(ctx context.Context, u identity, ws Workspace, result rowBodyResult, operationID string, draft *rowBodyDraft) error {
	state, err := s.placementState(ctx, u, result.PageID)
	if err != nil {
		return err
	}
	initial, planErr := draftInsertPlan(state, draft)
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialize commits per row, including a newly imported/migrated existing body.
	lockKey, _ := json.Marshal([]string{result.ParentID, result.RowID})
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, string(lockKey)); err != nil {
		return err
	}
	var digest, bodyID, actor string
	var raw []byte
	var complete bool
	err = tx.QueryRow(ctx, `SELECT digest,body_id,user_id,plan,complete FROM row_body_drafts WHERE document_id=$1 AND row_id=$2 AND operation_id=$3 FOR UPDATE`, result.ParentID, result.RowID, operationID).Scan(&digest, &bodyID, &actor, &raw, &complete)
	var plan rowBodyEditPlan
	if errors.Is(err, pgx.ErrNoRows) {
		if planErr != nil {
			return planErr
		}
		plan = initial
		raw, _ = json.Marshal(plan)
		if _, err = tx.Exec(ctx, `INSERT INTO row_body_drafts(document_id,row_id,operation_id,digest,body_id,plan,user_id) VALUES($1,$2,$3,$4,$5,$6,$7)`, result.ParentID, result.RowID, operationID, draft.Digest, result.PageID, raw, u.ID); err != nil {
			return err
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		// The immutable plan must survive a successful edit whose SQL ack is lost.
		return s.commitRowBodyDraft(ctx, u, ws, result, operationID, draft)
	}
	if err != nil {
		return err
	}
	if digest != draft.Digest || bodyID != result.PageID || actor != u.ID {
		return placementRefusal(409, "operationId already belongs to different row-body content")
	}
	if json.Unmarshal(raw, &plan) != nil {
		return errors.New("invalid saved row draft plan")
	}
	if _, err = s.existingRowBody(ctx, u, ws, result.ParentID, result.RowID, result.PageID); err != nil {
		return err
	}
	if complete {
		return nil
	}
	if len(plan.Ops) == 0 {
		if _, err = tx.Exec(ctx, `UPDATE row_body_drafts SET complete=true WHERE document_id=$1 AND row_id=$2 AND operation_id=$3`, result.ParentID, result.RowID, operationID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	for attempt := 0; attempt < 3; attempt++ {
		if _, err = s.existingRowBody(ctx, u, ws, result.ParentID, result.RowID, result.PageID); err != nil {
			return err
		}
		current, e := s.placementState(ctx, u, result.PageID)
		if e != nil {
			return e
		}
		if current.Lineage != plan.Lineage {
			return placementRefusal(409, "Body lineage changed; retained draft requires review")
		}
		response, e := s.placementHTTP(ctx, u, result.PageID, http.MethodPost, "edit", plan.Head, plan.Operation, map[string]any{"ops": plan.Ops})
		if e != nil {
			return e
		}
		if response.Code == 204 {
			current, e = s.placementState(ctx, u, result.PageID)
			if e != nil {
				return e
			}
			if current.Lineage != plan.Lineage {
				return placementRefusal(409, "Body lineage changed after draft commit")
			}
			for _, b := range draft.Blocks {
				actual, ok := findPlacementBlock(current, b.ID)
				if !ok || actual.Type != b.Type || actual.Parent != b.Parent {
					return placementRefusal(409, "Committed draft blocks were removed or moved; review before retrying")
				}
			}
			// The source may have been retargeted while the body journal committed.
			// Retain that durable content but do not acknowledge a different owner.
			if _, e = s.existingRowBody(ctx, u, ws, result.ParentID, result.RowID, result.PageID); e != nil {
				return e
			}
			if e = s.projectPlacementDocument(ctx, u, result.PageID); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE row_body_drafts SET complete=true WHERE document_id=$1 AND row_id=$2 AND operation_id=$3`, result.ParentID, result.RowID, operationID); e != nil {
				return e
			}
			return tx.Commit(ctx)
		}
		if response.Code != 412 {
			return placementRefusal(response.Code, "Could not commit row-body draft; repeat the same operationId and content")
		}
		current, e = s.placementState(ctx, u, result.PageID)
		if e != nil {
			return e
		}
		if current.Lineage != plan.Lineage {
			return placementRefusal(409, "Body lineage changed; retained draft requires review")
		}
		plan, e = draftInsertPlan(current, draft)
		if e != nil {
			return e
		}
		encoded, _ := json.Marshal(plan)
		if _, e = tx.Exec(ctx, `UPDATE row_body_drafts SET plan=$4 WHERE document_id=$1 AND row_id=$2 AND operation_id=$3`, result.ParentID, result.RowID, operationID, encoded); e != nil {
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		next, e := nextRowBodyAttempt(ctx, "draft")
		if e != nil {
			return e
		}
		return s.commitRowBodyDraft(next, u, ws, result, operationID, draft)
	}
	return placementRefusal(409, "Body changed repeatedly; preserve the draft and retry")
}
