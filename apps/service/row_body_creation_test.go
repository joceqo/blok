package cloud

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestMCPNewRowBodyIsCreatedOnceAndInheritsAccess(t *testing.T) {
	w := newReadsWorld(t)
	seedRowParent(t, w, false)
	args := map[string]any{"workspace": "equipe", "pageId": "prive", "rowId": "sprint"}
	first := managementCall(t, w, "bob", "blok_open_row_body", args, false)
	id, ok := first["pageId"].(string)
	if !ok || id == "" || id == "prive" {
		t.Fatalf("missing distinct body document: %v", first)
	}
	again := managementCall(t, w, "bob", "blok_open_row_body", args, false)
	if again["pageId"] != id {
		t.Fatalf("duplicate body: %v / %v", first, again)
	}
	var count int
	if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages WHERE metadata->'rowBodyOf'->>'documentId'='prive' AND metadata->'rowBodyOf'->>'rowId'='sprint'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("body count=%d err=%v", count, err)
	}
	w.assertMCPPage(t, "bob", id, true, true)
	w.assertMCPPage(t, "alice", id, false, false)
	state := recoveryState(t, w, identity{User: User{ID: "bob"}, Session: hash(tokenBob)}, "prive")
	row, found := findPlacementBlock(state, "sprint")
	if !found || row.Data["pageId"] != id {
		t.Fatalf("row did not acquire durable body: %v", row)
	}
}

func TestMCPNewRowBodyRefusesPrivateRowsWithoutCreatingDocuments(t *testing.T) {
	w := newReadsWorld(t)
	seedRowParent(t, w, false)
	var before, after int
	if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	managementCall(t, w, "alice", "blok_open_row_body", map[string]any{"workspace": "equipe", "pageId": "prive", "rowId": "sprint"}, true)
	if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&after); err != nil || before != after {
		t.Fatalf("refusal created documents: %d -> %d (%v)", before, after, err)
	}
}

func TestNewRowBodyDraftHTTPIsImmutableAndAppends(t *testing.T) {
	w := newReadsWorld(t)
	bodyID := seedRowParent(t, w, true)
	u := identity{User: User{ID: "bob"}, Session: hash(tokenBob)}
	recoveryEdit(t, w, u, bodyID, "peer", []map[string]any{{"op": "insert", "id": "peer", "block": map[string]any{"type": "paragraph", "data": map[string]any{"text": "Peer text"}}}})
	draft := map[string]any{"blocks": []any{map[string]any{"id": "draft", "type": "paragraph", "data": map[string]any{"text": "My draft"}, "tunes": map[string]any{"alignment": "right"}}}}
	request := map[string]any{"rowId": "sprint", "operationId": "draft-op", "body": draft}
	path := "/api/workspaces/equipe/pages/prive/row-body"
	first := w.post(t, tokenBob, path, request, 200)
	again := w.post(t, tokenBob, path, request, 200)
	if first["pageId"] != bodyID || again["pageId"] != bodyID {
		t.Fatalf("unstable body: %v / %v", first, again)
	}
	state := recoveryState(t, w, u, bodyID)
	if len(state.Blocks) != 2 || state.Blocks[0].ID != "peer" || state.Blocks[1].ID != "draft" {
		t.Fatalf("peer overwritten or duplicate: %#v", state.Blocks)
	}
	var block map[string]any
	json.Unmarshal(state.Blocks[1].Original, &block)
	if block["tunes"].(map[string]any)["alignment"] != "right" {
		t.Fatal("draft tunes lost")
	}
	draft["blocks"].([]any)[0].(map[string]any)["data"] = map[string]any{"text": "Changed payload"}
	w.post(t, tokenBob, path, request, 409)
	after := recoveryState(t, w, u, bodyID)
	got, _ := findPlacementBlock(after, "draft")
	if after.Head != state.Head || !reflect.DeepEqual(got.Data["text"], []any{map[string]any{"text": "My draft"}}) {
		t.Fatalf("refused retry changed prior commit: head %s -> %s; text %#v", state.Head, after.Head, got.Data["text"])
	}
}

func TestNewRowBodyDraftCanCreateFiveNestedBodies(t *testing.T) {
	w := newReadsWorld(t)
	seedRowParent(t, w, false)
	document := "prive"
	rowID := "sprint"
	for depth := 0; depth < 5; depth++ {
		db := fmt.Sprintf("db-%d", depth)
		row := fmt.Sprintf("row-%d", depth)
		draft := map[string]any{"blocks": []any{
			map[string]any{"id": db, "type": "database", "data": map[string]any{"schema": []any{map[string]any{"id": "title", "type": "title"}}}, "content": []string{row}},
			map[string]any{"id": row, "type": "database-row", "parent": db, "data": map[string]any{"properties": map[string]any{"title": fmt.Sprintf("Nested %d", depth)}}},
		}}
		got := w.post(t, tokenBob, "/api/workspaces/equipe/pages/"+document+"/row-body", map[string]any{"rowId": rowID, "operationId": "nested-draft", "body": draft}, 200)
		body := got["pageId"].(string)
		if body == document {
			t.Fatal("body reused source document")
		}
		document = body
		rowID = row
	}
	managementCall(t, w, "bob", "blok_open_row_body", map[string]any{"workspace": "equipe", "pageId": document, "rowId": rowID}, false)
}

func TestNewRowBodyCreatorLosesAccessWhenSourceRevoked(t *testing.T) {
	w := newReadsWorld(t)
	seedRowParent(t, w, false)
	if _, err := w.service.DB.Exec(w.ctx, `INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('prive','alice','edit','bob')`); err != nil {
		t.Fatal(err)
	}
	got := managementCall(t, w, "alice", "blok_open_row_body", map[string]any{"workspace": "equipe", "pageId": "prive", "rowId": "sprint"}, false)
	id := got["pageId"].(string)
	if w.levelOf(t, "alice", id) != levelEdit {
		t.Fatal("body did not inherit edit")
	}
	var count int
	if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM page_shares WHERE page_id=$1`, id).Scan(&count); err != nil || count != 0 {
		t.Fatalf("body has direct grants: %d %v", count, err)
	}
	if _, err := w.service.DB.Exec(w.ctx, `DELETE FROM page_shares WHERE page_id='prive' AND user_id='alice'`); err != nil {
		t.Fatal(err)
	}
	w.assertMCPPage(t, "alice", id, false, false)
}

func TestNewRowBodyConcurrentOpenAllocatesOnce(t *testing.T) {
	w := newReadsWorld(t)
	seedRowParent(t, w, false)
	type result struct {
		status int
		data   map[string]any
		err    error
	}
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			req, _ := http.NewRequest("POST", w.server.URL+"/api/workspaces/equipe/pages/prive/row-body", strings.NewReader(`{"rowId":"sprint"}`))
			req.Header.Set("Authorization", "Bearer "+tokenBob)
			req.Header.Set("Origin", w.service.Config.PublicURL)
			req.Header.Set("Content-Type", "application/json")
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				results <- result{err: err}
				return
			}
			defer response.Body.Close()
			var data map[string]any
			err = json.NewDecoder(response.Body).Decode(&data)
			results <- result{response.StatusCode, data, err}
		}()
	}
	one, two := <-results, <-results
	if one.err != nil || two.err != nil || one.status != 200 || two.status != 200 || one.data["pageId"] != two.data["pageId"] {
		t.Fatalf("concurrent opens: %+v / %+v", one, two)
	}
	var count int
	if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM row_body_creations WHERE document_id='prive' AND row_id='sprint'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("allocation count %d %v", count, err)
	}
}

func TestNewRowBodyDraftLostAcknowledgement(t *testing.T) {
	w := newReadsWorld(t)
	bodyID := seedRowParent(t, w, true)
	for _, sql := range []string{
		`CREATE FUNCTION fail_draft_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.complete THEN RAISE EXCEPTION 'lost draft acknowledgement'; END IF; RETURN NEW; END $$`,
		`CREATE TRIGGER fail_draft_ack BEFORE UPDATE ON row_body_drafts FOR EACH ROW EXECUTE FUNCTION fail_draft_ack()`,
	} {
		if _, err := w.service.DB.Exec(w.ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	request := map[string]any{"rowId": "sprint", "operationId": "retry-op", "body": map[string]any{"blocks": []any{map[string]any{"id": "draft", "type": "paragraph", "data": map[string]any{"text": "Retain me"}}}}}
	// An immutable plan exists before a peer writes. The first edit gets 412,
	// forcing a durable replan; then the SQL acknowledgement is lost.
	u := identity{User: User{ID: "bob"}, Session: hash(tokenBob)}
	rawDraft, _ := json.Marshal(request["body"])
	draft, err := parseRowBodyDraft(rawDraft)
	if err != nil {
		t.Fatal(err)
	}
	original, err := draftInsertPlan(recoveryState(t, w, u, bodyID), draft)
	if err != nil {
		t.Fatal(err)
	}
	rawPlan, _ := json.Marshal(original)
	if _, err = w.service.DB.Exec(w.ctx, `INSERT INTO row_body_drafts(document_id,row_id,operation_id,digest,body_id,plan,user_id) VALUES('prive','sprint','retry-op',$1,$2,$3,'bob')`, draft.Digest, bodyID, rawPlan); err != nil {
		t.Fatal(err)
	}
	recoveryEdit(t, w, u, bodyID, "peer-before-draft", []map[string]any{{"op": "insert", "id": "peer", "block": map[string]any{"type": "paragraph", "data": map[string]any{"text": "Peer survived"}}}})
	path := "/api/workspaces/equipe/pages/prive/row-body"
	failed := w.post(t, tokenBob, path, request, 503)
	if failed["pageId"] != bodyID {
		t.Fatalf("missing recovery identity: %v", failed)
	}
	var saved rowBodyEditPlan
	if err = w.service.DB.QueryRow(w.ctx, `SELECT plan FROM row_body_drafts WHERE document_id='prive' AND row_id='sprint' AND operation_id='retry-op'`).Scan(&rawPlan); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(rawPlan, &saved); err != nil || saved.Operation == original.Operation {
		t.Fatalf("successful replan was not durable: %v", err)
	}
	if _, err := w.service.DB.Exec(w.ctx, `DROP TRIGGER fail_draft_ack ON row_body_drafts`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		w.post(t, tokenBob, path, request, 200)
	}
	state := recoveryState(t, w, identity{User: User{ID: "bob"}, Session: hash(tokenBob)}, bodyID)
	if len(state.Blocks) != 2 || state.Blocks[0].ID != "peer" || state.Blocks[1].ID != "draft" {
		t.Fatalf("lost ack duplicated body: %#v", state.Blocks)
	}
}

func TestNewRowBodyKeepsCommentsPropertiesAndTitle(t *testing.T) {
	w := newReadsWorld(t)
	seedRowParent(t, w, false)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content='{"blocks":[{"id":"db","type":"database","data":{"schema":[{"id":"name","type":"title"}]},"content":["sprint"]},{"id":"sprint","type":"database-row","parent":"db","data":{"properties":{"name":"Named sprint","priority":"High"},"reminders":{"date":{"at":123}}},"tunes":{"alignment":"left"},"content":["comment"]},{"id":"comment","type":"database-comment","parent":"sprint","data":{"text":"Stay on the row"}}]}' WHERE id='prive'`); err != nil {
		t.Fatal(err)
	}
	got := managementCall(t, w, "bob", "blok_open_row_body", map[string]any{"workspace": "equipe", "pageId": "prive", "rowId": "sprint"}, false)
	state := recoveryState(t, w, identity{User: User{ID: "bob"}, Session: hash(tokenBob)}, "prive")
	row, _ := findPlacementBlock(state, "sprint")
	if row.Data["bodyBlocks"] != true || row.Data["properties"].(map[string]any)["priority"] != "High" || row.Data["reminders"] == nil {
		t.Fatalf("row data lost: %#v", row.Data)
	}
	if comment, ok := findPlacementBlock(state, "comment"); !ok || comment.Parent != "sprint" {
		t.Fatal("comment moved away from source")
	}
	var original map[string]any
	json.Unmarshal(row.Original, &original)
	if original["tunes"] == nil {
		t.Fatal("row tunes lost")
	}
	var title string
	if err := w.service.DB.QueryRow(w.ctx, `SELECT metadata->>'title' FROM pages WHERE id=$1`, got["pageId"]).Scan(&title); err != nil || title != "Named sprint" {
		t.Fatalf("wrong body title %q %v", title, err)
	}
}

func TestNewRowBodyRejectsMalformedDraftBeforeAllocation(t *testing.T) {
	cases := []string{
		`{"blocks":[{"id":"same","type":"paragraph","data":{}},{"id":"same","type":"paragraph","data":{}}]}`,
		`{"blocks":[{"id":"orphan","type":"paragraph","parent":"outside","data":{}}]}`,
		`{"blocks":[{"id":"cycle","type":"paragraph","parent":"cycle","data":{}}]}`,
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			w := newReadsWorld(t)
			seedRowParent(t, w, false)
			var before, after int
			w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&before)
			w.post(t, tokenBob, "/api/workspaces/equipe/pages/prive/row-body", map[string]any{"rowId": "sprint", "operationId": "bad", "body": json.RawMessage(raw)}, 400)
			if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&after); err != nil || after != before {
				t.Fatalf("invalid body allocated page: %d->%d %v", before, after, err)
			}
		})
	}
}

func TestNewRowBodyLinkReplansWithoutLosingConcurrentProperties(t *testing.T) {
	w := newReadsWorld(t)
	seedRowParent(t, w, false)
	u := identity{User: User{ID: "bob"}, Session: hash(tokenBob)}
	state := recoveryState(t, w, u, "prive")
	row, _ := findPlacementBlock(state, "sprint")
	w.page(t, "reserved-body", "prive", visInherit)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"prive","rowId":"sprint"}}'::jsonb WHERE id='reserved-body'`); err != nil {
		t.Fatal(err)
	}
	plan := rowLinkPlan(state, row, "reserved-body")
	raw, _ := json.Marshal(plan)
	if _, err := w.service.DB.Exec(w.ctx, `INSERT INTO row_body_creations(document_id,row_id,body_id,plan) VALUES('prive','sprint','reserved-body',$1)`, raw); err != nil {
		t.Fatal(err)
	}
	recoveryEdit(t, w, u, "prive", "peer-property", []map[string]any{{"op": "update", "id": "sprint", "data": map[string]any{"properties": map[string]any{"title": "Changed by peer", "priority": "Urgent"}, "reminders": map[string]any{"due": 123}}}})
	got := managementCall(t, w, "bob", "blok_open_row_body", map[string]any{"workspace": "equipe", "pageId": "prive", "rowId": "sprint"}, false)
	if got["pageId"] != "reserved-body" {
		t.Fatalf("allocated twice: %v", got)
	}
	row, _ = findPlacementBlock(recoveryState(t, w, u, "prive"), "sprint")
	if row.Data["properties"].(map[string]any)["priority"] != "Urgent" || row.Data["reminders"] == nil {
		t.Fatalf("CAS replan lost peer data: %#v", row.Data)
	}
	var saved rowBodyEditPlan
	if err := w.service.DB.QueryRow(w.ctx, `SELECT plan FROM row_body_creations WHERE document_id='prive' AND row_id='sprint'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(raw, &saved)
	if saved.Operation == plan.Operation {
		t.Fatal("stale plan was not replaced after conflict")
	}
}
