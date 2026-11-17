package cloud

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestRowBodyHostPreventsMaintenanceWhileServing(t *testing.T) {
	ctx, _, open := permissionsFixture(t)
	service := open()
	conn, err := service.DB.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	var acquired bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(774839103,hashtext(current_schema()))`).Scan(&acquired); err != nil {
		t.Fatal(err)
	}
	if acquired {
		conn.Exec(ctx, `SELECT pg_advisory_unlock(774839103,hashtext(current_schema()))`)
		t.Fatal("maintenance acquired exclusive lock while service was running")
	}
}

func TestRowBodyHostRefusesUnfinishedMigration(t *testing.T) {
	ctx, _, open := permissionsFixture(t)
	service := open()
	seedWorld(t, ctx, service)
	seedPage(t, ctx, service, "source", "w", "", visWorkspace)
	_, err := service.DB.Exec(ctx, `INSERT INTO row_body_migrations(source_id,workspace_id,state,source_before,source_after,body_pages) VALUES('source','w','prepared','{"blocks":[]}','{"blocks":[]}','[]')`)
	if err != nil {
		t.Fatal(err)
	}
	next, err := New(ctx, service.Config)
	if next != nil {
		next.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "migration") {
		t.Fatalf("unfinished migration admitted startup: %v", err)
	}
}

func TestRowBodyHostKeepsInternalPagesOutOfSidebarAndIndexDeletion(t *testing.T) {
	world := newReadsWorld(t)
	seedPage(t, world.ctx, world.service, "body", "w", "public", visInherit)
	_, err := world.service.DB.Exec(world.ctx, `UPDATE pages SET metadata=metadata || '{"rowBodyOf":{"documentId":"public","rowId":"r"}}'::jsonb WHERE id='body'`)
	if err != nil {
		t.Fatal(err)
	}
	// The index must retain permission information for the body, without listing it as a page.
	status, response := world.get(t, tokenAlice, "/api/workspaces/equipe/index")
	if status != 200 {
		t.Fatalf("index status %d", status)
	}
	raw, _ := json.Marshal(response["pages"])
	if strings.Contains(string(raw), `"id":"body"`) {
		t.Fatal("internal body appeared in sidebar")
	}
	access, _ := response["access"].(map[string]any)
	if access["body"] == nil {
		t.Fatal("row body access disappeared")
	}
	world.putIndex(t, tokenAlice, []map[string]any{entry("public", nil)}, 0, 200)
	if !world.alive(t, "body") {
		t.Fatal("saving sidebar deleted its hidden body document")
	}
	var parent string
	if err := world.service.DB.QueryRow(context.Background(), `SELECT metadata->>'parentId' FROM pages WHERE id='body'`).Scan(&parent); err != nil || parent != "public" {
		t.Fatalf("row body lost inheritance: %q %v", parent, err)
	}
	world.send(t, "PUT", tokenAlice, "/api/workspaces/equipe/index", map[string]any{"pages": []any{}, "trash": []any{entry("public", nil)}, "revision": 1}, 200)
	if allowed, err := world.service.authorizeDoc(world.ctx, hash(tokenAlice), "body", true); err != nil || allowed {
		t.Fatalf("trashed body accepts edits: %v %v", allowed, err)
	}
	world.putIndex(t, tokenAlice, []map[string]any{entry("public", nil)}, 2, 200)
	if allowed, err := world.service.authorizeDoc(world.ctx, hash(tokenAlice), "body", true); err != nil || !allowed {
		t.Fatalf("restored body cannot be edited: %v %v", allowed, err)
	}
	world.putIndex(t, tokenAlice, []map[string]any{}, 3, 200)
	if world.alive(t, "body") {
		t.Fatal("permanently deleted source left a live internal body")
	}

}

func TestRowBodyHostCopiesBodiesAndRefusesReservedSidebarMetadata(t *testing.T) {
	w := newReadsWorld(t)
	_, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content='{"blocks":[{"id":"db","type":"database","data":{},"content":["r"]},{"id":"r","parent":"db","type":"database-row","data":{"pageId":"body","bodyBlocks":true}}]}' WHERE id='public'`)
	if err != nil {
		t.Fatal(err)
	}

	w.page(t, "body", "public", visInherit)
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content='{"blocks":[{"id":"p","type":"paragraph","data":{"text":"Copied body"}}]}' WHERE id='body'`); err != nil {
		t.Fatal(err)
	}
	w.send(t, "POST", tokenAlice, "/api/workspaces/equipe/pages/public/duplicate", map[string]any{"id": "copy", "title": "Copy"}, 201)
	_, copied := w.get(t, tokenAlice, "/api/workspaces/equipe/pages/copy")
	row := rowPlanBlock(t, copied, "r")
	if row["data"].(map[string]any)["pageId"] != nil {
		t.Fatal("copy still shares its source body")
	}
	if rowPlanBlock(t, copied, "p")["parent"] != "r" {
		t.Fatal("body was not inlined under copied row")
	}

	w.putIndex(t, tokenAlice, []map[string]any{{"id": "public", "title": "Public", "parentId": nil, "rowBodyOf": map[string]string{"documentId": "public", "rowId": "r"}}}, 1, 400)
}
