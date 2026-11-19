package cloud

import "testing"

func TestNewRowBodyNeverMovesExistingContentOnline(t *testing.T) {
	cases := []struct{ name, data string }{
		{"paragraph", `{"blocks":[{"id":"db","type":"database","data":{},"content":["sprint"]},{"id":"sprint","type":"database-row","parent":"db","data":{"properties":{}},"content":["text"]},{"id":"text","type":"paragraph","parent":"sprint","data":{"text":"Keep my writing"}}]}`},
		{"empty-paragraph-may-have-an-offline-writer", `{"blocks":[{"id":"db","type":"database","data":{},"content":["sprint"]},{"id":"sprint","type":"database-row","parent":"db","data":{"properties":{}},"content":["text"]},{"id":"text","type":"paragraph","parent":"sprint","data":{"text":[]}}]}`},
		{"nested-database", `{"blocks":[{"id":"db","type":"database","data":{},"content":["sprint"]},{"id":"sprint","type":"database-row","parent":"db","data":{"properties":{}},"content":["tasks"]},{"id":"tasks","type":"database","parent":"sprint","data":{},"content":["task"]},{"id":"task","type":"database-row","parent":"tasks","data":{"properties":{}},"content":["text"]},{"id":"text","type":"paragraph","parent":"task","data":{"text":"Nested task"}}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := newReadsWorld(t)
			if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content=$1 WHERE id='prive'`, tc.data); err != nil {
				t.Fatal(err)
			}
			var before int
			if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			got := managementCall(t, w, "bob", "blok_open_row_body", map[string]any{"workspace": "equipe", "pageId": "prive", "rowId": "sprint"}, true)
			if got["status"] != float64(409) {
				t.Fatalf("existing body requires explicit migration: %v", got)
			}
			var after int
			if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&after); err != nil || after != before {
				t.Fatalf("refused transfer allocated body: %d -> %d (%v)", before, after, err)
			}
			state := recoveryState(t, w, identity{User: User{ID: "bob"}, Session: hash(tokenBob)}, "prive")
			row, ok := findPlacementBlock(state, "sprint")
			if !ok || row.Data["pageId"] != nil {
				t.Fatalf("refused transfer rewrote row: %v", row)
			}
			if _, ok := findPlacementBlock(state, "text"); !ok {
				t.Fatal("refused transfer deleted original content")
			}
		})
	}
}

func TestNewRowBodyRejectsTemplateAndMismatchedExistingOwner(t *testing.T) {
	cases := []struct {
		name      string
		separated bool
		sql       string
	}{
		{"legacy-body", false, `UPDATE pages SET content=jsonb_set(content,'{blocks,1,data,properties,details}','{"blocks":[{"id":"legacy","type":"paragraph","data":{"text":"Retain legacy"}}]}') WHERE id='prive'`},
		{"template", false, `UPDATE pages SET content=jsonb_set(content,'{blocks,1,data,template}','true') WHERE id='prive'`},
		{"mismatched-owner", true, `UPDATE pages SET metadata=jsonb_set(metadata,'{rowBodyOf,rowId}','"another"') WHERE id='sprint-body'`},
		{"trashed-body", true, `UPDATE pages SET trashed=true WHERE id='sprint-body'`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := newReadsWorld(t)
			seedRowParent(t, w, tc.separated)
			if _, err := w.service.DB.Exec(w.ctx, tc.sql); err != nil {
				t.Fatal(err)
			}
			var before, after int
			if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			managementCall(t, w, "bob", "blok_open_row_body", map[string]any{"workspace": "equipe", "pageId": "prive", "rowId": "sprint"}, true)
			if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&after); err != nil || after != before {
				t.Fatalf("invalid row allocated body: %d -> %d (%v)", before, after, err)
			}
		})
	}
}
