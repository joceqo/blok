package cloud

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/JackUait/blok/packages/server/go/v2/blokagent"
	"github.com/JackUait/blok/packages/server/go/v2/blokmcp"
)

// Use the hosted MCP transport, not the standalone source mode: the parent
// is a room document while parentId in block.insert is a row block.
func TestMCPSubpageInRowInheritsDocumentWorkspaceAndAccess(t *testing.T) {
	for _, separated := range []bool{false, true} {
		name := "inline"
		if separated {
			name = "separated-body"
		}
		t.Run(name, func(t *testing.T) {
			w := newReadsWorld(t)
			parent, row := "prive", "sprint"
			content := `{"blocks":[{"id":"db","type":"database","data":{},"content":["sprint"]},{"id":"sprint","type":"database-row","parent":"db","data":{"properties":{}},"content":[]}]}`
			if separated {
				parent, row = "sprint-body", ""
				w.page(t, parent, "prive", visInherit)
				if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"prive","rowId":"sprint"}}'::jsonb WHERE id=$1`, parent); err != nil {
					t.Fatal(err)
				}
				content = `{"blocks":[]}`
			}
			if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content=$2 WHERE id=$1`, parent, content); err != nil {
				t.Fatal(err)
			}
			opened := managementCall(t, w, "bob", "blok_open", map[string]any{"documentId": parent, "write": true}, false)
			handle := opened["handle"]
			defer managementCall(t, w, "bob", "blok_close", map[string]any{"handle": handle}, false)
			args := map[string]any{"type": "page", "id": "commits-link", "position": "end"}
			if row != "" {
				args["parentId"] = row
			}
			result := managementCall(t, w, "bob", "blok_execute", map[string]any{"handle": handle, "commands": []any{map[string]any{"name": "block.insert", "args": args}}}, false)
			if result["ok"] != true {
				t.Fatalf("insert: %v", result)
			}
			var child, workspace, visibility string
			if err := w.service.DB.QueryRow(w.ctx, `SELECT id,workspace_id,visibility FROM pages WHERE metadata->>'parentId'=$1 AND id<>'enfant' AND NOT (metadata ? 'rowBodyOf')`, parent).Scan(&child, &workspace, &visibility); err != nil {
				t.Fatal(err)
			}
			if workspace != "w" || visibility != visInherit {
				t.Fatalf("child scope: %s %s", workspace, visibility)
			}
			for _, user := range []string{"alice", "zoe"} {
				allowed, err := w.service.authorizeMCPDocument(w.ctx, user, child, false)
				if err != nil || allowed {
					t.Fatalf("private child leaked to %s: %v %v", user, allowed, err)
				}
			}
			renamed := managementCall(t, w, "bob", "blok_execute", map[string]any{"handle": handle, "commands": []any{map[string]any{"name": "page.rename", "args": map[string]any{"id": "commits-link", "title": "Commits"}}}}, false)
			if renamed["ok"] != true {
				t.Fatalf("rename: %v", renamed)
			}
			childOpen := managementCall(t, w, "bob", "blok_open", map[string]any{"documentId": child, "write": true}, false)
			childHandle := childOpen["handle"]
			defer managementCall(t, w, "bob", "blok_close", map[string]any{"handle": childHandle}, false)
			childRead := managementCall(t, w, "bob", "blok_read", map[string]any{"handle": childHandle}, false)
			page, _ := childRead["page"].(map[string]any)
			if page["title"] != "Commits" {
				t.Fatalf("child title: %v", childRead)
			}
			wrote := managementCall(t, w, "bob", "blok_execute", map[string]any{"handle": childHandle, "commands": []any{map[string]any{"name": "block.insert", "args": map[string]any{"id": "commit-one", "type": "paragraph", "data": map[string]any{"text": "First commit"}, "position": "end"}}}}, false)
			if wrote["ok"] != true {
				t.Fatal(wrote)
			}
			source := managementCall(t, w, "bob", "blok_read", map[string]any{"handle": handle}, false)
			raw, _ := json.Marshal(source)
			if strings.Contains(string(raw), "First commit") {
				t.Fatal("child content leaked into parent document")
			}
			// Read-only handles may inspect page links but must create no documents.
			before := 0
			if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			ro := managementCall(t, w, "bob", "blok_open", map[string]any{"documentId": parent, "write": false}, false)
			defer managementCall(t, w, "bob", "blok_close", map[string]any{"handle": ro["handle"]}, false)
			managementCall(t, w, "bob", "blok_execute", map[string]any{"handle": ro["handle"], "commands": []any{map[string]any{"name": "block.insert", "args": map[string]any{"type": "page", "position": "end"}}}}, true)
			after := 0
			if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&after); err != nil || after != before {
				t.Fatalf("read-only created documents: %d -> %d (%v)", before, after, err)
			}
			// Flush the real room projection too: the desktop resolves this link
			// from the workspace index, not from the MCP read of the child room.
			if err := w.service.Blok.Drain(w.ctx); err != nil {
				t.Fatal(err)
			}
			status, index := w.get(t, tokenBob, "/api/workspaces/equipe/index")
			if status != 200 {
				t.Fatalf("index status: %d", status)
			}
			found := false
			for _, rawPage := range index["pages"].([]any) {
				page := rawPage.(map[string]any)
				if page["id"] == child {
					found = true
					if page["title"] != "Commits" {
						t.Fatalf("desktop link title: %v", page)
					}
				}
			}
			if !found {
				t.Fatal("created subpage missing from workspace index")
			}
		})
	}
}

func TestMCPSubpageCreatorRechecksParentRightsAndIgnoresActorIdentity(t *testing.T) {
	w := newReadsWorld(t)
	count := func() int {
		var n int
		if err := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM pages`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := count()
	for _, request := range []blokagent.PageCreateRequest{
		{Principal: "alice", ParentDocumentID: "prive", Actor: blokagent.Actor{ID: "bob"}},
		{Principal: "zoe", ParentDocumentID: "prive"},
		{Principal: "bob", ParentDocumentID: "missing"},
		{ParentDocumentID: "prive"},
		{Principal: "bob"},
	} {
		id, err := w.service.createMCPPageDocument(w.ctx, request)
		if id != "" || !errors.Is(err, blokmcp.ErrPageRefused) {
			t.Fatalf("unexpected creation: %q %v", id, err)
		}
	}
	if _, err := w.service.DB.Exec(w.ctx, `DELETE FROM page_shares WHERE page_id='prive' AND user_id='bob'`); err != nil {
		t.Fatal(err)
	}
	if id, err := w.service.createMCPPageDocument(w.ctx, blokagent.PageCreateRequest{Principal: "bob", ParentDocumentID: "prive"}); id != "" || !errors.Is(err, blokmcp.ErrPageRefused) {
		t.Fatalf("revoked permission created %q: %v", id, err)
	}
	if after := count(); after != before {
		t.Fatalf("refusals created pages: %d -> %d", before, after)
	}
}

func TestMCPSubpageDatabaseFailureIsNotPermissionRefusal(t *testing.T) {
	w := newReadsWorld(t)
	// Break only this test's isolated schema after the parent lookup succeeds.
	if _, err := w.service.DB.Exec(w.ctx, `ALTER TABLE memberships RENAME TO unavailable_memberships`); err != nil {
		t.Fatal(err)
	}
	id, err := w.service.createMCPPageDocument(w.ctx, blokagent.PageCreateRequest{Principal: "bob", ParentDocumentID: "prive"})
	if id != "" || err == nil || errors.Is(err, blokmcp.ErrPageRefused) {
		t.Fatalf("database failure became permission denial: %q %v", id, err)
	}
}
