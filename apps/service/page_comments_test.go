package cloud

import (
	"bytes"
	"context"
	"testing"
)

func TestPageCommentGrantAddsThreadsWithoutDocumentWrite(t *testing.T) {
	w := newReadsWorld(t)
	const url = "/api/workspaces/equipe/pages/prive/comments"
	const grant = "/api/workspaces/equipe/pages/prive/shares/alice"
	w.send(t, "PUT", tokenBob, grant, map[string]string{"level": "view"}, 200)
	if _, err := w.service.DB.Exec(w.ctx, "UPDATE memberships SET role='viewer' WHERE workspace_id='w' AND user_id='alice'"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.service.DB.Exec(w.ctx, `UPDATE pages SET content='{"blocks":[{"id":"intro","type":"paragraph","data":{"text":"Original"}}]}' WHERE id='prive'`); err != nil {
		t.Fatal(err)
	}
	first := map[string]any{"text": "Une question", "requestId": "first", "authorId": "bob", "ops": []any{}}
	w.send(t, "POST", tokenAlice, url, first, 403)
	w.send(t, "PUT", tokenBob, grant, map[string]string{"level": "comment"}, 200)
	u := identity{User: User{ID: "alice"}, Session: hash(tokenAlice)}
	if ok, err := w.service.authorizeDoc(w.ctx, u.Session, "prive", true); err != nil || ok {
		t.Fatalf("document write: %v %v", ok, err)
	}
	if res, err := w.service.placementHTTP(w.ctx, u, "prive", "POST", "edit", "", "", nil); err != nil || res.Code != 403 {
		t.Fatalf("generic edit endpoint must refuse the commenter: %v %v", res, err)
	}
	owner := identity{User: User{ID: "bob"}, Session: hash(tokenBob)}
	before := recoveryState(t, w, owner, "prive")
	added := w.send(t, "POST", tokenAlice, url, first, 201)
	id := added["commentId"].(string)
	again := w.send(t, "POST", tokenAlice, url, first, 200)
	if again["commentId"] != id {
		t.Fatal("duplicate comment on retry")
	}
	w.send(t, "POST", tokenAlice, url, map[string]string{"text": "Merci", "requestId": "second", "threadId": id}, 201)
	state := recoveryState(t, w, owner, "prive")
	if len(state.Blocks) != 3 || !bytes.Equal(state.Blocks[0].Original, before.Blocks[0].Original) || state.Blocks[1].Type != "database-comment" || state.Blocks[1].Data["authorId"] != "alice" || state.Blocks[2].Parent != id {
		t.Fatal(state.Blocks)
	}
	reply := managementCall(t, w, "alice", "blok_add_page_comment", map[string]any{"workspace": "equipe", "pageId": "prive", "threadId": id, "requestId": "mcp", "text": "Depuis MCP"}, false)
	if reply["commentId"] == nil {
		t.Fatal(reply)
	}
	w.send(t, "PUT", tokenBob, grant, map[string]string{"level": "view"}, 200)
	w.send(t, "POST", tokenAlice, url, first, 403)
}

func TestCommentShareUpgradePreservesExistingViewGrant(t *testing.T) {
	ctx, _, open := permissionsFixture(t)
	s := open()
	seedWorld(t, ctx, s)
	seedPage(t, ctx, s, "private", "w", "", visPrivate)
	_, err := s.DB.Exec(ctx, `ALTER TABLE page_shares DROP CONSTRAINT page_shares_level_check,
		ADD CONSTRAINT page_shares_level_check CHECK(level IN ('view','edit','full'));
		DELETE FROM schema_migrations WHERE version=15;
		INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('private','bob','view','alice')`)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	migrated := open()
	level, err := migrated.effectiveLevel(ctx, migrated.DB, "bob", "private")
	if err != nil || level != levelView {
		t.Fatalf("old share after upgrade: %v %v", level, err)
	}
	if _, err := migrated.DB.Exec(ctx, `UPDATE page_shares SET level='comment' WHERE page_id='private' AND user_id='bob'`); err != nil {
		t.Fatal(err)
	}
}

// Exercise the same membership, index, ticket and sharing routes used by the client.
func TestGuestMembershipRequiresNamedSharesAndCannotCreatePages(t *testing.T) {
	w := newReadsWorld(t)
	const base = "/api/workspaces/equipe"
	w.send(t, "POST", tokenZoe, base+"/invites", map[string]any{"email": "reader@example.test", "role": "guest", "silent": true}, 201)
	var invitationRole string
	if err := w.service.DB.QueryRow(w.ctx, "SELECT role FROM invites WHERE email='reader@example.test'").Scan(&invitationRole); err != nil || invitationRole != "guest" {
		t.Fatalf("guest invite: %s %v", invitationRole, err)
	}
	w.send(t, "PATCH", tokenZoe, base+"/members/alice", map[string]string{"role": "guest"}, 200)
	team := w.newTeamspace(t, "Équipe")
	w.tsMember(t, team, "alice", "member")
	teamPage := w.tsPage(t, team, "Réunion", "")
	status, index := w.get(t, tokenAlice, base+"/index")
	if status != 200 || len(index["pages"].([]any)) != 0 || len(w.mcpPages(t, "alice")) != 0 {
		t.Fatal(index)
	}
	if status, _ := w.get(t, tokenAlice, base+"/ticket?doc=public"); status != 404 {
		t.Fatalf("unshared page ticket: %d", status)
	}
	w.putIndex(t, tokenAlice, []map[string]any{entry("perso", nil)}, 0, 403)
	ctx := context.WithValue(w.ctx, mcpUserKey{}, identity{User: User{ID: "alice"}})
	result, err := w.service.mcpCreatePage(ctx, mcpRequestFor(t, map[string]any{"workspace": "equipe", "title": "Personnelle", "visibility": "private"}))
	if err != nil || !result.IsError {
		t.Fatalf("guest private page creation: %v %v", result, err)
	}
	const grant = base + "/pages/prive/shares/alice"
	w.send(t, "PUT", tokenBob, grant, map[string]string{"level": "edit"}, 400)
	w.send(t, "PUT", tokenBob, grant, map[string]string{"level": "view"}, 200)
	w.send(t, "POST", tokenAlice, base+"/pages/prive/comments", map[string]string{"requestId": "read", "text": "Question"}, 403)
	w.send(t, "PUT", tokenBob, grant, map[string]string{"level": "comment"}, 200)
	w.send(t, "POST", tokenAlice, base+"/pages/enfant/comments", map[string]string{"requestId": "reply", "text": "Question"}, 201)
	w.assertMCPPage(t, "alice", "enfant", true, false)
	w.send(t, "POST", tokenAlice, base+"/pages/prive/duplicate", map[string]any{"id": "copie", "title": "Copie"}, 403)
	w.send(t, "PUT", tokenZoe, base+"/pages/"+teamPage+"/shares/alice", map[string]string{"level": "view"}, 200)
	_, index = w.get(t, tokenAlice, base+"/index")
	access := index["access"].(map[string]any)
	if len(access) != 3 || access["prive"].(map[string]any)["sharedWithMe"] != true || access["enfant"].(map[string]any)["level"] != "comment" {
		t.Fatal(index)
	}
	w.send(t, "DELETE", tokenBob, grant, nil, 200)
	w.assertMCPPage(t, "alice", "enfant", false, false)
	w.assertMCPPage(t, "alice", teamPage, true, false)
	w.send(t, "DELETE", tokenZoe, base+"/teamspaces/"+team+"/members/alice", nil, 200)
	w.assertMCPPage(t, "alice", teamPage, false, false)
}
