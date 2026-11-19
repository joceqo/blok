package cloud

import (
	"encoding/json"
	"testing"
)

func seedRowParent(t *testing.T, w *readsWorld, separated bool) string {
	t.Helper()
	body := "prive"
	rowData := map[string]any{"properties": map[string]any{"title": "Sprint #1"}}
	if separated {
		body = "sprint-body"
		w.page(t, body, "prive", visInherit)
		rowData["pageId"] = body
		if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"prive","rowId":"sprint"}}'::jsonb WHERE id=$1`, body); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := json.Marshal(map[string]any{"blocks": []any{
		map[string]any{"id": "db", "type": "database", "data": map[string]any{"schema": []any{map[string]any{"id": "title", "type": "title"}}}, "content": []string{"sprint"}},
		map[string]any{"id": "sprint", "type": "database-row", "parent": "db", "data": rowData, "content": []string{}},
	}})
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content=$1 WHERE id='prive'`, data); err != nil {
		t.Fatal(err)
	}
	return body
}

func assertRowSubpage(t *testing.T, w *readsWorld, id, body string) {
	t.Helper()
	var parent string
	if err := w.service.DB.QueryRow(w.ctx, `SELECT metadata->>'parentId' FROM pages WHERE id=$1`, id).Scan(&parent); err != nil || parent != body {
		t.Fatalf("storage parent %q: %v", parent, err)
	}
	listed := managementCall(t, w, "bob", "blok_list_pages", map[string]any{"workspace": "equipe"}, false)
	for _, raw := range listed["pages"].([]any) {
		page := raw.(map[string]any)
		if page["id"] != id {
			continue
		}
		location, ok := page["location"].(map[string]any)
		if !ok || location["documentId"] != "prive" {
			t.Fatalf("missing row location: %v", page)
		}
		rows, _ := location["rows"].([]any)
		if len(rows) != 1 || rows[0].(map[string]any)["rowId"] != "sprint" {
			t.Fatalf("wrong row parent: %v", location)
		}
		return
	}
	t.Fatal("subpage absent from index")
}

func TestMCPCreatePageUnderRow(t *testing.T) {
	for _, separated := range []bool{false, true} {
		name := "inline"
		if separated {
			name = "separated"
		}
		t.Run(name, func(t *testing.T) {
			w := newReadsWorld(t)
			body := seedRowParent(t, w, separated)
			created := managementCall(t, w, "bob", "blok_create_page", map[string]any{"workspace": "equipe", "title": "Commits", "parentId": "prive", "parentRowId": "sprint"}, false)
			id, ok := created["id"].(string)
			if !ok {
				t.Fatal(created)
			}
			assertRowSubpage(t, w, id, body)
			w.assertMCPPage(t, "alice", id, false, false)
		})
	}
}

func TestMCPMovePageUnderRow(t *testing.T) {
	for _, separated := range []bool{false, true} {
		name := "inline"
		if separated {
			name = "separated"
		}
		t.Run(name, func(t *testing.T) {
			w := newReadsWorld(t)
			body := seedRowParent(t, w, separated)
			result := managementCall(t, w, "bob", "blok_move_page", map[string]any{"workspace": "equipe", "pageId": "enfant", "parentId": "prive", "parentRowId": "sprint"}, false)
			if result["id"] != "enfant" {
				t.Fatal(result)
			}
			assertRowSubpage(t, w, "enfant", body)
			again := managementCall(t, w, "bob", "blok_move_page", map[string]any{"workspace": "equipe", "pageId": "enfant", "parentId": "prive", "parentRowId": "sprint"}, false)
			if again["revision"] != result["revision"] {
				t.Fatalf("retry changed revision: %v / %v", result, again)
			}
		})
	}
}

func TestMCPCreateRowPageRequestID(t *testing.T) {
	w := newReadsWorld(t)
	seedRowParent(t, w, true)
	args := map[string]any{"workspace": "equipe", "title": "Commits", "parentId": "prive", "parentRowId": "sprint", "requestId": "create-commits"}
	first := managementCall(t, w, "bob", "blok_create_page", args, false)
	again := managementCall(t, w, "bob", "blok_create_page", args, false)
	if first["id"] != again["id"] || first["revision"] != again["revision"] {
		t.Fatalf("retry changed receipt: %v / %v", first, again)
	}
	args["title"] = "Changed request"
	managementCall(t, w, "bob", "blok_create_page", args, true)
	args["title"] = "Commits"
	managementCall(t, w, "bob", "blok_move_page", map[string]any{"workspace": "equipe", "pageId": first["id"], "parentId": nil}, false)
	again = managementCall(t, w, "bob", "blok_create_page", args, false)
	if first["id"] != again["id"] || first["revision"] != again["revision"] {
		t.Fatalf("lost-response replay changed receipt after later move: %v / %v", first, again)
	}
	var parent *string
	if err := w.service.DB.QueryRow(w.ctx, `SELECT metadata->>'parentId' FROM pages WHERE id=$1`, first["id"]).Scan(&parent); err != nil || parent != nil {
		t.Fatalf("create replay moved page back: %v %v", parent, err)
	}
}

func TestMCPRowBodyDirectParentAndMoveOut(t *testing.T) {
	w := newReadsWorld(t)
	body := seedRowParent(t, w, true)
	created := managementCall(t, w, "bob", "blok_create_page", map[string]any{"workspace": "equipe", "title": "Direct body child", "parentId": body}, false)
	id := created["id"].(string)
	assertRowSubpage(t, w, id, body)
	managementCall(t, w, "bob", "blok_move_page", map[string]any{"workspace": "equipe", "pageId": id, "parentId": "public"}, false)
	user := identity{User: User{ID: "bob"}, Session: hash(tokenBob)}
	old, err := w.service.placementState(w.ctx, user, body)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range old.Blocks {
		if b.Type == "page" && b.Data["pageId"] == id {
			t.Fatal("old row pointer survived move")
		}
	}
	next, err := w.service.placementState(w.ctx, user, "public")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, b := range next.Blocks {
		if b.Type == "page" && b.Data["pageId"] == id {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("ordinary page needs one moved structural pointer, got %d", count)
	}
	managementCall(t, w, "bob", "blok_move_page", map[string]any{"workspace": "equipe", "pageId": id, "parentId": nil}, false)
	next, err = w.service.placementState(w.ctx, user, "public")
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range next.Blocks {
		if b.Type == "page" && b.Data["pageId"] == id {
			t.Fatal("root move left prior pointer")
		}
	}
}

func TestMCPCreateUnderNestedSeparatedRow(t *testing.T) {
	w := newReadsWorld(t)
	outer := seedRowParent(t, w, true)
	w.page(t, "nested-body", outer, visInherit)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"sprint-body","rowId":"nested-row"}}'::jsonb WHERE id='nested-body'; UPDATE pages SET content='{"blocks":[{"id":"nested-db","type":"database","data":{"schema":[{"id":"title","type":"title"}]},"content":["nested-row"]},{"id":"nested-row","type":"database-row","parent":"nested-db","data":{"pageId":"nested-body","properties":{"title":"Nested row"}},"content":[]}]}'::jsonb WHERE id='sprint-body'`); err != nil {
		t.Fatal(err)
	}
	created := managementCall(t, w, "bob", "blok_create_page", map[string]any{"workspace": "equipe", "title": "Nested child", "parentId": outer, "parentRowId": "nested-row"}, false)
	user := identity{User: User{ID: "bob"}, Session: hash(tokenBob)}
	state, err := w.service.placementState(w.ctx, user, "nested-body")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, b := range state.Blocks {
		if b.Type == "page" && b.Data["pageId"] == created["id"] {
			count++
			if b.Parent != "" {
				t.Fatal("nested body child must be at body root")
			}
		}
	}
	if count != 1 {
		t.Fatal("missing nested body page pointer")
	}
}

func TestMCPCreateRowPageRequestIDResumesInterruptedPlacement(t *testing.T) {
	w := newReadsWorld(t)
	body := seedRowParent(t, w, true)
	if _, err := w.service.DB.Exec(w.ctx, `CREATE FUNCTION fail_create_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.plan->>'applied'='true' THEN RAISE EXCEPTION 'lost create acknowledgement'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_create_ack BEFORE UPDATE ON page_placements FOR EACH ROW EXECUTE FUNCTION fail_create_ack()`); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"workspace": "equipe", "title": "Recovered child", "parentId": "prive", "parentRowId": "sprint", "requestId": "recover-create"}
	failed := managementCall(t, w, "bob", "blok_create_page", args, true)
	if failed["status"] != float64(503) {
		t.Fatal(failed)
	}
	details := failed["error"].(map[string]any)["details"].(map[string]any)
	id, ok := details["pageId"].(string)
	if !ok || id == "" || details["operationId"] == nil {
		t.Fatalf("missing recovery details: %v", failed)
	}
	var before int
	if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := w.service.DB.Exec(w.ctx, `DROP TRIGGER fail_create_ack ON page_placements`); err != nil {
		t.Fatal(err)
	}
	first := managementCall(t, w, "bob", "blok_create_page", args, false)
	again := managementCall(t, w, "bob", "blok_create_page", args, false)
	if first["id"] != id || again["id"] != id || first["revision"] != again["revision"] {
		t.Fatalf("creation recovery changed identity/receipt: %v / %v", first, again)
	}
	var after int
	if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&after); err != nil || before != after {
		t.Fatalf("recovery duplicated pages: before=%d after=%d err=%v", before, after, err)
	}
	assertRowSubpage(t, w, id, body)
}
