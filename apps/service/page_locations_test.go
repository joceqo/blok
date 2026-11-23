package cloud

import (
	"encoding/json"
	"fmt"
	"testing"
)

func locationFixture(t *testing.T, w *readsWorld, document, child string, depth int) {
	t.Helper()
	blocks := []map[string]any{}
	parent := ""
	for i := 1; i <= depth; i++ {
		db, row := fmt.Sprintf("db%d", i), fmt.Sprintf("row%d", i)
		blocks = append(blocks, map[string]any{"id": db, "type": "database", "parent": parent, "data": map[string]any{"schema": []map[string]string{{"id": "name", "type": "title"}}}}, map[string]any{"id": row, "type": "database-row", "parent": db, "data": map[string]any{"title": "stale title", "properties": map[string]string{"name": fmt.Sprintf("Sprint %d", i)}}})
		parent = row
	}
	blocks = append(blocks, map[string]any{"id": "link", "type": "page", "parent": parent, "data": map[string]string{"pageId": child}})
	raw, _ := json.Marshal(map[string]any{"blocks": blocks})
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content=$2 WHERE id=$1`, document, raw); err != nil {
		t.Fatal(err)
	}
}

func pageFromList(t *testing.T, response map[string]any, id string) map[string]any {
	t.Helper()
	for _, raw := range response["pages"].([]any) {
		p := raw.(map[string]any)
		if p["id"] == id {
			return p
		}
	}
	t.Fatalf("page %s absent", id)
	return nil
}

func TestPageLocationRestoresFiveInlineRowAncestorsAcrossHTTPAndMCP(t *testing.T) {
	w := newReadsWorld(t)
	w.page(t, "commits", "public", visInherit)
	locationFixture(t, w, "public", "commits", 5)
	resolved := w.send(t, "GET", tokenAlice, "/api/pages/resolve-id/commits", nil, 200)
	check := func(p map[string]any) {
		t.Helper()
		loc, ok := p["location"].(map[string]any)
		if !ok {
			t.Fatalf("missing structural parent: %#v", p)
		}
		if loc["documentId"] != "public" || loc["blockId"] != "row5" || loc["blockDocumentId"] != "public" {
			t.Fatal(loc)
		}
		rows := loc["rows"].([]any)
		if len(rows) != 5 {
			t.Fatal(rows)
		}
		for i, raw := range rows {
			row := raw.(map[string]any)
			if row["rowId"] != fmt.Sprintf("row%d", i+1) || row["title"] != fmt.Sprintf("Sprint %d", i+1) || row["documentId"] != "public" {
				t.Fatal(row)
			}
		}
	}
	check(resolved)
	index := w.send(t, "GET", tokenAlice, "/api/workspaces/equipe/index", nil, 200)
	check(pageFromList(t, index, "commits"))
	check(pageFromList(t, managementCall(t, w, "alice", "blok_list_pages", map[string]any{"workspace": "equipe"}, false), "commits"))
	// Existing content gains its ancestry without a migration, and moving the
	// link changes that ancestry without editing the workspace index.
	locationFixture(t, w, "public", "commits", 1)
	after := w.send(t, "GET", tokenAlice, "/api/pages/resolve-id/commits", nil, 200)
	if len(after["location"].(map[string]any)["rows"].([]any)) != 1 {
		t.Fatal(after)
	}
}

func TestPageLocationNeverDisclosesPrivateParentToSharedChild(t *testing.T) {
	w := newReadsWorld(t)
	w.page(t, "commits", "prive", visInherit)
	locationFixture(t, w, "prive", "commits", 1)
	if _, err := w.service.DB.Exec(w.ctx, `INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('commits','alice','view','bob')`); err != nil {
		t.Fatal(err)
	}
	got := w.send(t, "GET", tokenAlice, "/api/pages/resolve-id/commits", nil, 200)
	if _, ok := got["location"]; ok {
		t.Fatal("private row leaked", got)
	}
	index := w.send(t, "GET", tokenAlice, "/api/workspaces/equipe/index", nil, 200)
	if _, ok := pageFromList(t, index, "commits")["location"]; ok {
		t.Fatal("private index location leaked", index)
	}
}

func TestPageLocationSeparateBodyAndIndexRoundTrip(t *testing.T) {
	w := newReadsWorld(t)
	w.page(t, "body", "public", visInherit)
	w.page(t, "commits", "body", visInherit)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"public","rowId":"sprint"}}'::jsonb,content='{"blocks":[{"id":"link","type":"page","data":{"pageId":"commits"}}]}'::jsonb WHERE id='body'; UPDATE pages SET content='{"blocks":[{"id":"db","type":"database","data":{}},{"id":"sprint","type":"database-row","parent":"db","data":{"title":"Sprint #1","pageId":"body"}}]}'::jsonb WHERE id='public'`); err != nil {
		t.Fatal(err)
	}
	got := w.send(t, "GET", tokenAlice, "/api/pages/resolve-id/commits", nil, 200)
	loc, ok := got["location"].(map[string]any)
	if !ok || loc["documentId"] != "public" || loc["blockId"] != "sprint" || loc["blockDocumentId"] != "public" {
		t.Fatal(got)
	}
	rows := loc["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["title"] != "Sprint #1" {
		t.Fatal(loc)
	}
	index := w.send(t, "GET", tokenAlice, "/api/workspaces/equipe/index", nil, 200)
	if listedIDs(t, index)["body"] {
		t.Fatal("body should remain hidden")
	}
	child := pageFromList(t, index, "commits")
	if child["parentId"] != "body" {
		t.Fatal("storage parent changed", child)
	}
	child["location"] = map[string]any{"documentId": "prive", "blockId": "forged", "rows": []any{}}
	w.send(t, "PUT", tokenAlice, "/api/workspaces/equipe/index", map[string]any{"pages": index["pages"], "trash": index["trash"], "revision": index["revision"]}, 200)
	var forged bool
	if err := w.service.DB.QueryRow(w.ctx, `SELECT metadata ? 'location' FROM pages WHERE id='commits'`).Scan(&forged); err != nil || forged {
		t.Fatalf("derived location persisted: %v %v", forged, err)
	}
	fresh := w.send(t, "GET", tokenAlice, "/api/workspaces/equipe/index", nil, 200)
	if pageFromList(t, fresh, "commits")["location"].(map[string]any)["documentId"] != "public" {
		t.Fatal(fresh)
	}
}

func TestPageLocationRejectsBrokenAmbiguousAndCyclicBlockPaths(t *testing.T) {
	for _, tc := range []struct{ name, blocks string }{
		{"missing parent", `[{"id":"link","type":"page","parent":"missing","data":{"pageId":"commits"}}]`},
		{"cycle", `[{"id":"db","type":"database","parent":"row","data":{}},{"id":"row","type":"database-row","parent":"db","data":{"title":"secret"}},{"id":"link","type":"page","parent":"row","data":{"pageId":"commits"}}]`},
		{"ambiguous", `[{"id":"db","type":"database","data":{}},{"id":"r1","type":"database-row","parent":"db","data":{}},{"id":"r2","type":"database-row","parent":"db","data":{}},{"id":"one","type":"page","parent":"r1","data":{"pageId":"commits"}},{"id":"two","type":"page","parent":"r2","data":{"pageId":"commits"}}]`},
		{"duplicate id", `[{"id":"db","type":"database","data":{}},{"id":"row","type":"database-row","parent":"db","data":{}},{"id":"row","type":"database-row","parent":"db","data":{}},{"id":"link","type":"page","parent":"row","data":{"pageId":"commits"}}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := newReadsWorld(t)
			w.page(t, "commits", "public", visInherit)
			if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content=$1::jsonb WHERE id='public'`, `{"blocks":`+tc.blocks+`}`); err != nil {
				t.Fatal(err)
			}
			got := w.send(t, "GET", tokenAlice, "/api/pages/resolve-id/commits", nil, 200)
			if got["location"] != nil {
				t.Fatal("invalid path accepted", got)
			}
		})
	}
}

func TestPageLocationSeparateBodyRequiresLiveTwoWayLink(t *testing.T) {
	w := newReadsWorld(t)
	w.page(t, "body", "public", visInherit)
	w.page(t, "commits", "body", visInherit)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"public","rowId":"sprint"}}'::jsonb,content='{"blocks":[{"id":"link","type":"page","data":{"pageId":"commits"}}]}'::jsonb WHERE id='body'; UPDATE pages SET content='{"blocks":[{"id":"db","type":"database","data":{}},{"id":"sprint","type":"database-row","parent":"db","data":{"title":"Old row","pageId":"other-body"}}]}'::jsonb WHERE id='public'`); err != nil {
		t.Fatal(err)
	}
	got := w.send(t, "GET", tokenAlice, "/api/pages/resolve-id/commits", nil, 200)
	if got["location"] != nil {
		t.Fatal("stale body backlink accepted", got)
	}
}

func TestPageLocationFiveLevelsCrossTwoSeparateBodyDocuments(t *testing.T) {
	w := newReadsWorld(t)
	w.page(t, "body-a", "public", visInherit)
	w.page(t, "body-b", "body-a", visInherit)
	w.page(t, "commits", "body-b", visInherit)
	source := `{"blocks":[{"id":"db1","type":"database","data":{}},{"id":"row1","type":"database-row","parent":"db1","data":{"title":"Sprint 1"}},{"id":"db2","type":"database","parent":"row1","data":{}},{"id":"row2","type":"database-row","parent":"db2","data":{"title":"Sprint 2","pageId":"body-a"}}]}`
	bodyA := `{"blocks":[{"id":"db3","type":"database","data":{}},{"id":"row3","type":"database-row","parent":"db3","data":{"title":"Sprint 3","pageId":"body-b"}}]}`
	bodyB := `{"blocks":[{"id":"db4","type":"database","data":{}},{"id":"row4","type":"database-row","parent":"db4","data":{"title":"Sprint 4"}},{"id":"db5","type":"database","parent":"row4","data":{}},{"id":"row5","type":"database-row","parent":"db5","data":{"title":"Sprint 5"}},{"id":"link","type":"page","parent":"row5","data":{"pageId":"commits"}}]}`
	for id, raw := range map[string]string{"public": source, "body-a": bodyA, "body-b": bodyB} {
		if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content=$2::jsonb WHERE id=$1`, id, raw); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"public","rowId":"row2"}}'::jsonb WHERE id='body-a';UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"body-a","rowId":"row3"}}'::jsonb WHERE id='body-b'`); err != nil {
		t.Fatal(err)
	}
	got := w.send(t, "GET", tokenAlice, "/api/pages/resolve-id/commits", nil, 200)
	loc, ok := got["location"].(map[string]any)
	if !ok || loc["documentId"] != "public" || loc["blockId"] != "row5" || loc["blockDocumentId"] != "body-b" {
		t.Fatal(got)
	}
	rows := loc["rows"].([]any)
	if len(rows) != 5 {
		t.Fatal(rows)
	}
	for i, doc := range []string{"public", "public", "body-a", "body-b", "body-b"} {
		row := rows[i].(map[string]any)
		if row["documentId"] != doc || row["rowId"] != fmt.Sprintf("row%d", i+1) {
			t.Fatal(row)
		}
	}
	body := w.send(t, "GET", tokenAlice, "/api/pages/resolve-id/body-b", nil, 200)
	bodyLoc, ok := body["location"].(map[string]any)
	if !ok || bodyLoc["documentId"] != "public" || bodyLoc["blockId"] != "row3" || bodyLoc["blockDocumentId"] != "body-a" || len(bodyLoc["rows"].([]any)) != 3 {
		t.Fatal(body)
	}
}

func TestPageLocationHiddenBodyParentCannotAuthorizeForgedIndexPlacement(t *testing.T) {
	w := newReadsWorld(t)
	w.page(t, "hidden-private-body", "prive", visInherit)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"prive","rowId":"secret"}}'::jsonb WHERE id='hidden-private-body'`); err != nil {
		t.Fatal(err)
	}
	index := w.send(t, "GET", tokenAlice, "/api/workspaces/equipe/index", nil, 200)
	public := pageFromList(t, index, "public")
	public["parentId"] = "hidden-private-body"
	public["location"] = map[string]any{"documentId": "public", "blockId": "secret", "rows": []any{}}
	w.send(t, "PUT", tokenAlice, "/api/workspaces/equipe/index", map[string]any{"pages": index["pages"], "trash": index["trash"], "revision": index["revision"]}, 400)
}

func TestPageLocationSharedChildUnderHiddenBodyDoesNotRevealPrivateSource(t *testing.T) {
	w := newReadsWorld(t)
	w.page(t, "body", "prive", visInherit)
	w.page(t, "commits", "body", visInherit)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"prive","rowId":"secret-row"}}'::jsonb,content='{"blocks":[{"id":"link","type":"page","data":{"pageId":"commits"}}]}'::jsonb WHERE id='body'; UPDATE pages SET content='{"blocks":[{"id":"db","type":"database","data":{}},{"id":"secret-row","type":"database-row","parent":"db","data":{"title":"Private sprint","pageId":"body"}}]}'::jsonb WHERE id='prive'; INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('body','alice','full','bob')`); err != nil {
		t.Fatal(err)
	}
	index := w.send(t, "GET", tokenAlice, "/api/workspaces/equipe/index", nil, 200)
	child := pageFromList(t, index, "commits")
	if child["parentId"] != nil || child["location"] != nil {
		t.Fatal("shared child must be a visible root without private row data", child)
	}
	access := index["access"].(map[string]any)["commits"].(map[string]any)
	if access["sharedRoot"] != true {
		t.Fatal("detachment must be explicit", access)
	}
	child["title"] = "Shared commits"
	w.send(t, "PUT", tokenAlice, "/api/workspaces/equipe/index", map[string]any{"pages": index["pages"], "trash": index["trash"], "revision": index["revision"]}, 200)
	var parent, title string
	if err := w.service.DB.QueryRow(w.ctx, `SELECT metadata->>'parentId',metadata->>'title' FROM pages WHERE id='commits'`).Scan(&parent, &title); err != nil || parent != "body" || title != "Shared commits" {
		t.Fatalf("shared index changed physical parent: %s %s %v", parent, title, err)
	}
	mcp := managementCall(t, w, "alice", "blok_list_pages", map[string]any{"workspace": "equipe"}, false)
	if pageFromList(t, mcp, "commits")["location"] != nil {
		t.Fatal("MCP disclosed private source", mcp)
	}
}

func TestPageLocationIndexCreatesNewChildUnderAccessibleHiddenBody(t *testing.T) {
	w := newReadsWorld(t)
	w.page(t, "body", "public", visInherit)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"public","rowId":"sprint"}}'::jsonb WHERE id='body'; UPDATE pages SET content='{"blocks":[{"id":"db","type":"database","data":{}},{"id":"sprint","type":"database-row","parent":"db","data":{"title":"Sprint","pageId":"body"}}]}'::jsonb WHERE id='public'`); err != nil {
		t.Fatal(err)
	}
	index := w.send(t, "GET", tokenAlice, "/api/workspaces/equipe/index", nil, 200)
	pages := append(index["pages"].([]any), map[string]any{"id": "new-child", "title": "New subpage", "parentId": "body"})
	w.send(t, "PUT", tokenAlice, "/api/workspaces/equipe/index", map[string]any{"pages": pages, "trash": index["trash"], "revision": index["revision"]}, 200)
	var parent, workspace string
	if err := w.service.DB.QueryRow(w.ctx, `SELECT metadata->>'parentId',workspace_id FROM pages WHERE id='new-child'`).Scan(&parent, &workspace); err != nil || parent != "body" || workspace != "w" {
		t.Fatalf("wrong new page parent: %s %s %v", parent, workspace, err)
	}
}

func TestIndexRoundTripWithTrashedRowBodyParent(t *testing.T) {
	w := newReadsWorld(t)
	w.page(t, "body", "public", visInherit)
	w.page(t, "child", "body", visInherit)
	w.page(t, "other", "", visWorkspace)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"public","rowId":"row"}}'::jsonb WHERE id='body'`); err != nil {
		t.Fatal(err)
	}
	w.send(t, "DELETE", tokenAlice, "/api/workspaces/equipe/pages/public", nil, 200)
	const path = "/api/workspaces/equipe/index"
	index := w.send(t, "GET", tokenAlice, path, nil, 200)
	pageFromList(t, index, "other")["title"] = "Updated title"
	payload := map[string]any{"pages": index["pages"], "trash": index["trash"], "revision": index["revision"]}
	// A new page cannot claim the omitted parent, even if it is sent in trash.
	trash := index["trash"].([]any)
	for _, bucket := range []string{"pages", "trash"} {
		bad := map[string]any{"pages": index["pages"], "trash": trash, "revision": index["revision"]}
		bad[bucket] = append(append([]any{}, bad[bucket].([]any)...), entry("new-child", "body"))
		w.send(t, "PUT", tokenAlice, path, bad, 400)
	}
	w.send(t, "PUT", tokenAlice, path, payload, 200)
	fresh := w.send(t, "GET", tokenAlice, path, nil, 200)
	if pageFromList(t, fresh, "other")["title"] != "Updated title" {
		t.Fatal("unrelated page edit was not saved")
	}
	var retained bool
	if err := w.service.DB.QueryRow(w.ctx, `SELECT trashed AND NOT deleted AND metadata->>'parentId'='body' FROM pages WHERE id='child'`).Scan(&retained); err != nil || !retained {
		t.Fatalf("expected to retain the child's original trash location: %v", err)
	}
}
