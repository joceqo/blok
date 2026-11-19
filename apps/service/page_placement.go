package cloud

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
)

// This context is only installed around an in-process /state or /edit request.
// A public bearer credential cannot set it or authenticate the browser API.
type placementIdentityKey struct{}
type placementFinalizingKey struct{}
type placementPlanningRetryKey struct{}
type placementProjectionKey struct{}
type placementProjection struct{ PreviousLineage *string }

type placementTarget struct {
	RequestedParent string `json:"requestedParent"`
	RequestedRow    string `json:"requestedRow"`
	Document        string `json:"document"`
	Parent          string `json:"parent"`
	RowDocument     string `json:"rowDocument,omitempty"`
	Row             string `json:"row,omitempty"`
}
type placementBlock struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Parent   string          `json:"parent,omitempty"`
	Content  []string        `json:"content,omitempty"`
	Data     map[string]any  `json:"data"`
	Original json.RawMessage `json:"original,omitempty"`
}
type placementSnapshot struct {
	Blocks   []placementBlock `json:"blocks"`
	Head     string           `json:"-"`
	Lineage  string           `json:"-"`
	Sequence string           `json:"-"`
	Document json.RawMessage  `json:"-"`
}
type pagePlacement struct {
	Operation    string           `json:"operation"`
	Target       placementTarget  `json:"target"`
	Source       string           `json:"source"`
	SourceHead   string           `json:"sourceHead"`
	TargetHead   string           `json:"targetHead"`
	SourceBlocks []placementBlock `json:"sourceBlocks"`
	CopyBlock    map[string]any   `json:"copyBlock,omitempty"`
	Pointer      string           `json:"pointer"`
	Title        string           `json:"title"`
	Complete     bool             `json:"complete"`
	Applied      bool             `json:"applied"`
	Revision     int64            `json:"revision"`
}
type placementFailure struct {
	status  int
	message string
}

func (e placementFailure) Error() string                { return e.message }
func placementRefusal(status int, message string) error { return placementFailure{status, message} }
func placementStatus(err error) int {
	var e placementFailure
	if errors.As(err, &e) {
		return e.status
	}
	var refusal scopedPageRefusal
	if errors.As(err, &refusal) {
		return 403
	}
	return 503
}

func (s *Service) placementHTTP(ctx context.Context, u identity, document, method, endpoint, head, operation string, value any) (*httptest.ResponseRecorder, error) {
	ticket, err := s.mintSessionTicket(u, document, true)
	if err != nil {
		return nil, err
	}
	var body []byte
	if value != nil {
		body, err = json.Marshal(value)
		if err != nil {
			return nil, err
		}
	}
	req := httptest.NewRequest(method, "/api/blok/sync/"+url.PathEscape(document)+"/"+endpoint+"?ticket="+url.QueryEscape(ticket), bytes.NewReader(body)).WithContext(context.WithValue(ctx, placementIdentityKey{}, u))
	req.Header.Set("Origin", s.Config.PublicURL)
	req.Header.Set("Authorization", "Bearer "+ticket)
	if head != "" {
		req.Header.Set("If-Match", head)
	}
	if operation != "" {
		req.Header.Set("Blok-Idempotency-Key", operation)
	}
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	s.blokHandler(s.Blok.Handler("/api/blok")).ServeHTTP(response, req)
	return response, nil
}
func (s *Service) placementState(ctx context.Context, u identity, document string) (placementSnapshot, error) {
	var state placementSnapshot
	response, err := s.placementHTTP(ctx, u, document, "GET", "state", "", "", nil)
	if err != nil {
		return state, err
	}
	if response.Code != 200 {
		return state, placementRefusal(response.Code, "Page container unavailable")
	}
	if json.Unmarshal(response.Body.Bytes(), &state) != nil {
		return state, errors.New("invalid live page state")
	}
	state.Head = response.Header().Get("ETag")
	state.Lineage = response.Header().Get("Blok-Doc-Lineage")
	state.Sequence = response.Header().Get("Blok-Doc-Sequence")
	state.Document = bytes.Clone(response.Body.Bytes())
	if state.Head == "" {
		return state, placementRefusal(503, "Page placement requires a durable document journal")
	}
	return state, nil
}
func (s *Service) placementDocument(ctx context.Context, u identity, workspace, id string) (locationMetadata, error) {
	var meta locationMetadata
	var raw []byte
	err := s.DB.QueryRow(ctx, `SELECT metadata FROM pages WHERE id=$1 AND workspace_id=$2 AND NOT deleted AND NOT trashed`, id, workspace).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return meta, placementRefusal(404, "Destination not found")
	}
	if err != nil {
		return meta, err
	}
	level, err := s.effectiveLevel(ctx, s.DB, u.ID, id)
	if err != nil {
		return meta, err
	}
	if level < levelView {
		return meta, placementRefusal(404, "Destination not found")
	}
	if level < levelEdit {
		return meta, placementRefusal(403, "Destination container write access required")
	}
	if json.Unmarshal(raw, &meta) != nil {
		return meta, errors.New("invalid page metadata")
	}
	return meta, nil
}
func findPlacementBlock(state placementSnapshot, id string) (placementBlock, bool) {
	for _, b := range state.Blocks {
		if b.ID == id {
			return b, true
		}
	}
	return placementBlock{}, false
}
func (s *Service) resolvePlacementTarget(ctx context.Context, u identity, workspace, parent, row string) (placementTarget, error) {
	target := placementTarget{RequestedParent: parent, RequestedRow: row, Document: parent}
	if parent == "" {
		if row != "" {
			return target, placementRefusal(400, "parentRowId requires its containing parentId")
		}
		return target, nil
	}
	meta, err := s.placementDocument(ctx, u, workspace, parent)
	if err != nil {
		return target, err
	}
	if row == "" && meta.RowBodyOf == nil {
		return target, nil
	}
	source := parent
	if row == "" {
		if meta.RowBodyOf.DocumentID == "" || meta.RowBodyOf.DocumentID != meta.ParentID {
			return target, placementRefusal(409, "Invalid row body ownership")
		}
		source = meta.RowBodyOf.DocumentID
		row = meta.RowBodyOf.RowID
		if _, err = s.placementDocument(ctx, u, workspace, source); err != nil {
			return target, err
		}
	}
	state, err := s.placementState(ctx, u, source)
	if err != nil {
		return target, err
	}
	block, ok := findPlacementBlock(state, row)
	if !ok || block.Type != "database-row" {
		return target, placementRefusal(404, "Destination row not found")
	}
	db, ok := findPlacementBlock(state, block.Parent)
	if !ok || db.Type != "database" {
		return target, placementRefusal(409, "Invalid database row parent")
	}
	target.RowDocument = source
	target.Row = row
	target.Document = source
	target.Parent = row
	body, _ := block.Data["pageId"].(string)
	if body != "" {
		bodyMeta, err := s.placementDocument(ctx, u, workspace, body)
		if err != nil {
			return target, err
		}
		if bodyMeta.RowBodyOf == nil || bodyMeta.ParentID != source || bodyMeta.RowBodyOf.DocumentID != source || bodyMeta.RowBodyOf.RowID != row {
			return target, placementRefusal(409, "Row body ownership does not match")
		}
		target.Document = body
		target.Parent = ""
	}
	if target.RequestedRow == "" && meta.RowBodyOf != nil && target.Document != parent {
		return target, placementRefusal(409, "Row no longer owns this body document")
	}
	return target, nil
}
func samePlacementTarget(a, b placementTarget) bool { return a == b }
func (b *placementBlock) UnmarshalJSON(raw []byte) error {
	type plain placementBlock
	if err := json.Unmarshal(raw, (*plain)(b)); err != nil {
		return err
	}
	if len(b.Original) == 0 {
		b.Original = bytes.Clone(raw)
	}
	return nil
}
func samePlacementBlock(a, b placementBlock) bool {
	var left, right any
	if json.Unmarshal(a.Original, &left) != nil || json.Unmarshal(b.Original, &right) != nil {
		return false
	}
	x, _ := json.Marshal(left)
	y, _ := json.Marshal(right)
	return bytes.Equal(x, y)
}
func samePlacementLineage(a, b string) bool {
	i := strings.LastIndex(a, ":")
	j := strings.LastIndex(b, ":")
	return i > 0 && j > 0 && a[:i] == b[:j]
}
func (s *Service) loadPlacement(ctx context.Context, q querier, id string) (*pagePlacement, error) {
	var raw []byte
	err := q.QueryRow(ctx, `SELECT plan FROM page_placements WHERE page_id=$1`, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var plan pagePlacement
	if json.Unmarshal(raw, &plan) != nil {
		return nil, errors.New("invalid saved page placement")
	}
	return &plan, nil
}
func (s *Service) savePlacement(ctx context.Context, tx pgx.Tx, id string, plan *pagePlacement) error {
	raw, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO page_placements(page_id,plan) VALUES($1,$2) ON CONFLICT(page_id) DO UPDATE SET plan=excluded.plan,updated_at=now()`, id, raw)
	return err
}

// Persist the exact identities before touching a live document. Retrying never
// invents a new destination pointer or removes a changed source block.
func (s *Service) planPlacement(ctx context.Context, u identity, id, source, title string, target placementTarget) (*pagePlacement, error) {
	plan := &pagePlacement{Operation: opaque(), Target: target, Source: source, Pointer: opaque(), Title: title}
	var sourceState placementSnapshot
	if source != "" {
		level, err := s.effectiveLevel(ctx, s.DB, u.ID, source)
		if err != nil {
			return nil, err
		}
		if level < levelEdit {
			return nil, placementRefusal(403, "Source container write access required to move its page pointer")
		}
		sourceState, err = s.placementState(ctx, u, source)
		if err != nil {
			return nil, err
		}
		plan.SourceHead = sourceState.Head
		for _, b := range sourceState.Blocks {
			if page, _ := b.Data["pageId"].(string); b.Type == "page" && page == id {
				if len(b.Content) > 0 {
					return nil, placementRefusal(409, "Page pointer unexpectedly owns inline content")
				}
				plan.SourceBlocks = append(plan.SourceBlocks, b)
			}
		}
	}
	if len(plan.SourceBlocks) > 1 {
		return nil, placementRefusal(409, "Multiple owning page pointers require review before moving")
	}
	if len(plan.SourceBlocks) == 1 {
		if err := json.Unmarshal(plan.SourceBlocks[0].Original, &plan.CopyBlock); err != nil {
			return nil, err
		}
		delete(plan.CopyBlock, "parent")
		delete(plan.CopyBlock, "content")
		for key := range plan.CopyBlock {
			switch key {
			case "id", "type", "data", "tunes", "lastEditedAt", "lastEditedBy", "lastEditedWith", "createdAt", "createdBy", "createdWith":
			default:
				return nil, placementRefusal(409, "Page pointer contains unsupported metadata; original retained")
			}
		}
		plan.CopyBlock["id"] = plan.Pointer
	}
	if target.Document != "" {
		state := sourceState
		if target.Document != source {
			var err error
			state, err = s.placementState(ctx, u, target.Document)
			if err != nil {
				return nil, err
			}
		}
		plan.TargetHead = state.Head
		// A real pointer already in precisely this row/body makes a retry a no-op.
		if source == target.Document && len(plan.SourceBlocks) == 1 && plan.SourceBlocks[0].Parent == target.Parent {
			return nil, nil
		}
	}
	if len(plan.SourceBlocks) == 0 && target.Row == "" {
		return nil, nil
	}
	return plan, nil
}
func (s *Service) applyPlacementStep(ctx context.Context, u identity, workspace, id string, plan *pagePlacement, copy bool) error {
	document, head, suffix := plan.Source, plan.SourceHead, "remove"
	if copy {
		document, head, suffix = plan.Target.Document, plan.TargetHead, "copy"
	}
	if document == "" || (!copy && len(plan.SourceBlocks) == 0) {
		return nil
	}
	for attempt := 0; attempt < 3; attempt++ {
		target, err := s.resolvePlacementTarget(ctx, u, workspace, plan.Target.RequestedParent, plan.Target.RequestedRow)
		if err != nil {
			return err
		}
		if !samePlacementTarget(target, plan.Target) {
			return placementRefusal(409, "Destination row changed; the original page is retained")
		}
		state, err := s.placementState(ctx, u, document)
		if err != nil {
			return err
		}
		if !samePlacementLineage(head, state.Head) {
			return placementRefusal(409, "Document lineage changed; placement requires review")
		}
		ops := []map[string]any{}
		if copy {
			if existing, ok := findPlacementBlock(state, plan.Pointer); ok {
				if page, _ := existing.Data["pageId"].(string); existing.Type != "page" || page != id || existing.Parent != plan.Target.Parent {
					return placementRefusal(409, "Destination pointer changed; original retained")
				}
				return nil
			}
			if plan.Target.Parent != "" {
				row, ok := findPlacementBlock(state, plan.Target.Parent)
				if !ok || row.Type != "database-row" {
					return placementRefusal(409, "Destination row disappeared")
				}
			}
			var parent any
			if plan.Target.Parent != "" {
				parent = plan.Target.Parent
			}
			block := plan.CopyBlock
			if block == nil {
				block = map[string]any{"id": plan.Pointer, "type": "page", "data": map[string]any{"pageId": id, "title": plan.Title}}
			}
			ops = append(ops, map[string]any{"op": "insert", "id": plan.Pointer, "parent": parent, "after": nil, "block": block})
		} else {
			for _, expected := range plan.SourceBlocks {
				actual, ok := findPlacementBlock(state, expected.ID)
				if !ok {
					continue
				}
				if !samePlacementBlock(actual, expected) {
					return placementRefusal(409, "Source pointer changed; both locations retained for review")
				}
				ops = append(ops, map[string]any{"op": "remove", "id": expected.ID})
			}
			if len(ops) == 0 {
				return nil
			}
		}
		if !copy {
			if err = s.verifyPlacementCopy(ctx, u, id, plan); err != nil {
				return err
			}
		}
		response, err := s.placementHTTP(ctx, u, document, "POST", "edit", state.Head, plan.Operation+"-"+suffix, map[string]any{"ops": ops})
		if err != nil {
			return err
		}
		if response.Code == 204 {
			if copy {
				return s.verifyPlacementCopy(ctx, u, id, plan)
			}
			return s.verifyPlacementRemoval(ctx, u, plan)
		}
		if response.Code == 412 {
			continue
		}
		return placementRefusal(response.Code, "Page placement interrupted; repeat the same move to resume")
	}
	return placementRefusal(409, "Page container changed repeatedly; repeat the same move to resume")
}
func (s *Service) verifyPlacementCopy(ctx context.Context, u identity, id string, plan *pagePlacement) error {
	if plan.Target.Document == "" {
		return nil
	}
	state, err := s.placementState(ctx, u, plan.Target.Document)
	if err != nil {
		return err
	}
	b, ok := findPlacementBlock(state, plan.Pointer)
	page, _ := b.Data["pageId"].(string)
	if !samePlacementLineage(plan.TargetHead, state.Head) || !ok || b.Type != "page" || page != id || b.Parent != plan.Target.Parent {
		return placementRefusal(409, "Destination pointer disappeared or changed; placement requires review")
	}
	return nil
}
func (s *Service) verifyPlacementRemoval(ctx context.Context, u identity, plan *pagePlacement) error {
	if plan.Source == "" || len(plan.SourceBlocks) == 0 {
		return nil
	}
	state, err := s.placementState(ctx, u, plan.Source)
	if err != nil {
		return err
	}
	if !samePlacementLineage(plan.SourceHead, state.Head) {
		return placementRefusal(409, "Source lineage changed; placement requires review")
	}
	for _, expected := range plan.SourceBlocks {
		if _, ok := findPlacementBlock(state, expected.ID); ok {
			return placementRefusal(409, "Source pointer still exists or was recreated; placement requires review")
		}
	}
	return nil
}

// No workspace lock is held while the collaboration room persists/projections
// run. The operation row serializes retries, and the outer handler rechecks the
// workspace hierarchy and permissions before finalizing metadata.
func (s *Service) executePlacement(ctx context.Context, u identity, workspace, id string, expected *pagePlacement) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT plan FROM page_placements WHERE page_id=$1 FOR UPDATE`, id).Scan(&raw); err != nil {
		return err
	}
	var plan pagePlacement
	if json.Unmarshal(raw, &plan) != nil {
		return errors.New("invalid placement plan")
	}
	if plan.Operation != expected.Operation {
		return placementRefusal(409, "Page placement changed")
	}
	if !plan.Applied {
		if err = s.applyPlacementStep(ctx, u, workspace, id, &plan, true); err != nil {
			return err
		}
		if err = s.applyPlacementStep(ctx, u, workspace, id, &plan, false); err != nil {
			return err
		}
	}
	if err = s.verifyPlacementCopy(ctx, u, id, &plan); err != nil {
		return err
	}
	if err = s.verifyPlacementRemoval(ctx, u, &plan); err != nil {
		return err
	}
	for _, document := range uniquePlacementDocuments(&plan) {
		if err = s.projectPlacementDocument(ctx, u, document); err != nil {
			return err
		}
	}
	plan.Applied = true
	if err = s.savePlacement(ctx, tx, id, &plan); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func placementRequestDigest(title, parent, row, teamspace, visibility string) string {
	raw, _ := json.Marshal([]string{title, parent, row, teamspace, visibility})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func placementPendingError(id string, err error) error {
	return placementRefusal(placementStatus(err), fmt.Sprintf("Page %s retained; repeat blok_move_page with the same destination to resume: %s", id, err))
}

type pageCreatePlacement struct {
	Target    *placementTarget
	Plan      *pagePlacement
	RequestID string
	Digest    string
}

func (s *Service) finishCreatedPlacement(ctx context.Context, u identity, ws Workspace, out createdScopedPage) (createdScopedPage, error) {
	if out.placementComplete {
		return out, nil
	}
	plan, err := s.loadPlacement(ctx, s.DB, out.ID)
	if err != nil {
		return out, err
	}
	if plan == nil {
		return out, nil
	}
	if plan.Complete {
		out.Revision = plan.Revision
		return out, nil
	}
	value := map[string]any{"parentId": plan.Target.RequestedParent}
	if plan.Target.RequestedRow != "" {
		value["parentRowId"] = plan.Target.RequestedRow
	}
	raw, _ := json.Marshal(value)
	req := httptest.NewRequest(http.MethodPost, "http://placement.internal/", bytes.NewReader(raw)).WithContext(ctx)
	req.SetPathValue("id", out.ID)
	response := httptest.NewRecorder()
	s.movePage(response, req, u, ws)
	if response.Code != 200 {
		var failed struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &failed)
		return out, placementPendingError(out.ID, placementRefusal(response.Code, failed.Error))
	}
	var result struct {
		Revision int64 `json:"revision"`
	}
	if json.Unmarshal(response.Body.Bytes(), &result) != nil {
		return out, errors.New("invalid placement result")
	}
	out.Revision = result.Revision
	return out, nil
}

func uniquePlacementDocuments(plan *pagePlacement) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, id := range []string{plan.Target.Document, plan.Target.RowDocument, plan.Source} {
		if id != "" && !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	return result
}

// A journal room normally projects only at checkpoints or eviction. Publish its
// exact durable snapshot through the existing guarded projection handler so the
// next workspace index can derive the new ancestry immediately.
func (s *Service) projectPlacementDocument(ctx context.Context, u identity, document string) error {
	for attempt := 0; attempt < 3; attempt++ {
		var previous *string
		if err := s.DB.QueryRow(ctx, `SELECT lineage FROM pages WHERE id=$1`, document).Scan(&previous); err != nil {
			return err
		}
		state, err := s.placementState(ctx, u, document)
		if err != nil {
			return err
		}
		if state.Lineage == "" || state.Sequence == "" {
			return placementRefusal(503, "Missing durable projection head")
		}
		latest, err := s.placementState(ctx, u, document)
		if err != nil {
			return err
		}
		if latest.Head != state.Head {
			continue
		}
		req := httptest.NewRequest(http.MethodPut, "http://projection.internal/", bytes.NewReader(state.Document)).WithContext(context.WithValue(ctx, placementProjectionKey{}, placementProjection{previous}))
		req.SetPathValue("id", document)
		req.Header.Set("Authorization", "Bearer "+s.Config.InternalSecret)
		req.Header.Set("Blok-Doc-Lineage", state.Lineage)
		req.Header.Set("Blok-Doc-Sequence", state.Sequence)
		response := httptest.NewRecorder()
		s.document(response, req)
		if response.Code == 409 {
			continue
		}
		if response.Code != 200 {
			return placementRefusal(response.Code, "Could not publish page placement; repeat the same move")
		}
		latest, err = s.placementState(ctx, u, document)
		if err != nil {
			return err
		}
		if latest.Lineage != state.Lineage {
			continue
		}
		return nil
	}
	return placementRefusal(409, "Document changed while projecting placement; repeat the same move")
}

func samePlacementPlan(a, b *pagePlacement) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Operation == b.Operation && a.Complete == b.Complete
}
