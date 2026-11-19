package cloud

import "testing"

func TestMCPRowParentRefusalsDoNotCreatePages(t *testing.T) {
	cases := []struct {
		name, user, row, setup string
		separated              bool
	}{
		{name: "missing-row", user: "bob", row: "missing"},
		{name: "database-is-not-a-row", user: "bob", row: "db"},
		{name: "private-destination", user: "alice", row: "sprint"},
		{name: "admin-does-not-bypass-private-destination", user: "zoe", row: "sprint"},
		{name: "wrong-body-owner", user: "bob", row: "sprint", separated: true, setup: `UPDATE pages SET metadata=jsonb_set(metadata,'{rowBodyOf,rowId}','"another-row"') WHERE id='sprint-body'`},
		{name: "trashed-body", user: "bob", row: "sprint", separated: true, setup: `UPDATE pages SET trashed=true WHERE id='sprint-body'`},
		{name: "body-in-another-workspace", user: "bob", row: "sprint", separated: true, setup: `INSERT INTO workspaces(id,slug,name) VALUES('other','other','Other'); UPDATE pages SET workspace_id='other' WHERE id='sprint-body'`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := newReadsWorld(t)
			seedRowParent(t, w, tc.separated)
			if tc.setup != "" {
				if _, err := w.service.DB.Exec(w.ctx, tc.setup); err != nil {
					t.Fatal(err)
				}
			}
			var before int
			if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			managementCall(t, w, tc.user, "blok_create_page", map[string]any{"workspace": "equipe", "title": "Commits", "parentId": "prive", "parentRowId": tc.row}, true)
			var after int
			if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&after); err != nil || after != before {
				t.Fatalf("refused creation left documents: %d -> %d (%v)", before, after, err)
			}
		})
	}
}

func TestMCPRowParentRejectsCyclesAndProtectedBodySources(t *testing.T) {
	cases := []struct {
		name, page, parent, row string
		separated               bool
	}{
		{name: "own-inline-row", page: "prive", parent: "prive", row: "sprint"},
		{name: "own-separated-row", page: "prive", parent: "prive", row: "sprint", separated: true},
		{name: "body-cannot-be-detached-from-row", page: "sprint-body", parent: "public", separated: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := newReadsWorld(t)
			seedRowParent(t, w, tc.separated)
			var before string
			if err := w.service.DB.QueryRow(w.ctx, `SELECT metadata::text FROM pages WHERE id=$1`, tc.page).Scan(&before); err != nil {
				t.Fatal(err)
			}
			args := map[string]any{"workspace": "equipe", "pageId": tc.page, "parentId": tc.parent}
			if tc.row != "" {
				args["parentRowId"] = tc.row
			}
			managementCall(t, w, "bob", "blok_move_page", args, true)
			var after string
			if err := w.service.DB.QueryRow(w.ctx, `SELECT metadata::text FROM pages WHERE id=$1`, tc.page).Scan(&after); err != nil || before != after {
				t.Fatalf("refused move changed metadata: %s -> %s (%v)", before, after, err)
			}
		})
	}
}

func TestMCPRowParentRejectsMissingDestinationWithoutMovingSource(t *testing.T) {
	w := newReadsWorld(t)
	seedRowParent(t, w, false)
	managementCall(t, w, "bob", "blok_move_page", map[string]any{"workspace": "equipe", "pageId": "enfant", "parentId": "prive", "parentRowId": "missing"}, true)
	var parent string
	if err := w.service.DB.QueryRow(w.ctx, `SELECT metadata->>'parentId' FROM pages WHERE id='enfant'`).Scan(&parent); err != nil || parent != "prive" {
		t.Fatalf("refused move lost parent %q (%v)", parent, err)
	}
}
