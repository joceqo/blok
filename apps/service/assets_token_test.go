package cloud

import (
	"net/http"
	"testing"
)

// A custom emoji is a workspace's own picture, and the code already says a file
// with no page "reste commun aux membres". But membership was proved by a row in
// sessions alone, so an MCP token — a member's own credential — could read every
// document of a workspace and not one of its emojis. Importing them was
// impossible without borrowing a browser session.
func TestWorkspaceFileReadableWithAnMCPToken(t *testing.T) {
	w := newReadsWorld(t)
	emoji := managementCall(t, w, "alice", "blok_create_custom_emoji",
		map[string]any{"workspace": "equipe", "name": "logo", "dataUrl": tinyPNG}, false)
	url, _ := emoji["url"].(string)

	if url == "" {
		t.Fatal(emoji)
	}
	fetch := func(token string) int {
		req, _ := http.NewRequest("GET", w.server.URL+url, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()

		return resp.StatusCode
	}

	if code := fetch("management-alice"); code != 200 {
		t.Fatalf("a member's token should read a workspace emoji, got %d", code)
	}
	if code := fetch(""); code != 401 {
		t.Fatalf("no credential should still be refused, got %d", code)
	}
	if code := fetch("management-nobody"); code != 401 {
		t.Fatalf("an unknown token should be refused, got %d", code)
	}
}
