package cloud

import (
	"context"
	"encoding/json"
	"testing"
)

func documentTitleIndex(t *testing.T, w *readsWorld) (map[string]any, []map[string]any) {
	t.Helper()
	status, index := w.get(t, tokenAlice, "/api/workspaces/equipe/index")
	if status != 200 {
		t.Fatalf("index %d: %v", status, index)
	}
	pages := []map[string]any{}
	for _, raw := range index["pages"].([]any) {
		pages = append(pages, raw.(map[string]any))
	}
	return index, pages
}

func assertDocumentTitle(t *testing.T, pages []map[string]any, want string) {
	t.Helper()
	for _, page := range pages {
		if page["id"] == "public" {
			if page["title"] != want {
				t.Fatalf("title = %v, want %s", page["title"], want)
			}
			return
		}
	}
	t.Fatal("public missing")
}

func TestDocumentTitleChangeUpdatesPageListsAndRejectsStaleIndex(t *testing.T) {
	w := newReadsWorld(t)
	stale, pages := documentTitleIndex(t, w)
	w.send(t, "PUT", w.service.Config.InternalSecret, "/internal/documents/public", map[string]any{"blocks": []any{}, "title": "Commits"}, 200)
	fresh, updated := documentTitleIndex(t, w)
	assertDocumentTitle(t, updated, "Commits")
	if fresh["revision"].(float64) != stale["revision"].(float64)+1 {
		t.Fatalf("revision %v -> %v", stale["revision"], fresh["revision"])
	}
	w.putIndex(t, tokenAlice, pages, int(stale["revision"].(float64)), 409)
	ctx := context.WithValue(w.ctx, mcpUserKey{}, identity{ID: "alice"})
	result, err := w.service.mcpListPages(ctx, mcpRequestFor(t, map[string]any{"workspace": "equipe"}))
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Pages []map[string]any `json:"pages"`
	}
	if err = json.Unmarshal([]byte(mcpResultText(t, result)), &listed); err != nil {
		t.Fatal(err)
	}
	assertDocumentTitle(t, listed.Pages, "Commits")
}

func TestUnchangedDocumentTitlePreservesMetadataOnlyRename(t *testing.T) {
	w := newReadsWorld(t)
	doc := map[string]any{"blocks": []any{}, "title": "Original room title"}
	w.send(t, "PUT", w.service.Config.InternalSecret, "/internal/documents/public", doc, 200)
	index, pages := documentTitleIndex(t, w)
	for _, page := range pages {
		if page["id"] == "public" {
			page["title"] = "Sidebar rename"
		}
	}
	w.putIndex(t, tokenAlice, pages, int(index["revision"].(float64)), 200)
	before, _ := documentTitleIndex(t, w)
	doc["blocks"] = []any{map[string]any{"id": "body", "type": "paragraph", "data": map[string]any{"text": "An unrelated body edit"}}}
	w.send(t, "PUT", w.service.Config.InternalSecret, "/internal/documents/public", doc, 200)
	after, updated := documentTitleIndex(t, w)
	assertDocumentTitle(t, updated, "Sidebar rename")
	if after["revision"] != before["revision"] {
		t.Fatalf("body save bumped workspace revision: %v -> %v", before["revision"], after["revision"])
	}
	// A later genuine room rename supersedes the metadata-only name.
	doc["title"] = "New room title"
	w.send(t, "PUT", w.service.Config.InternalSecret, "/internal/documents/public", doc, 200)
	_, updated = documentTitleIndex(t, w)
	assertDocumentTitle(t, updated, "New room title")
}

func TestDocumentTitleProjectionOnlyAcceptsStringsAndNormalizesBlank(t *testing.T) {
	w := newReadsWorld(t)
	for _, title := range []any{nil, 42, map[string]any{"text": "bad"}} {
		before, _ := documentTitleIndex(t, w)
		w.send(t, "PUT", w.service.Config.InternalSecret, "/internal/documents/public", map[string]any{"blocks": []any{}, "title": title}, 200)
		after, pages := documentTitleIndex(t, w)
		assertDocumentTitle(t, pages, "public")
		if after["revision"] != before["revision"] {
			t.Fatal("invalid title changed workspace revision")
		}
	}
	w.send(t, "PUT", w.service.Config.InternalSecret, "/internal/documents/public", map[string]any{"blocks": []any{}, "title": "   "}, 200)
	_, pages := documentTitleIndex(t, w)
	assertDocumentTitle(t, pages, "Nouvelle page")
}
