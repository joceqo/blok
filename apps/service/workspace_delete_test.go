package cloud

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func workspaceDeletionAdmin(t *testing.T) *readsWorld {
	t.Helper()
	world := newReadsWorld(t)
	if _, err := world.service.DB.Exec(world.ctx, `INSERT INTO instance_admins(user_id) VALUES('zoe')`); err != nil {
		t.Fatal(err)
	}
	return world
}

func TestMCPDeleteWorkspaceRequiresInstanceAdministrator(t *testing.T) {
	world := workspaceDeletionAdmin(t)
	for _, user := range []string{"alice", "bob"} {
		result := managementCall(t, world, user, "blok_delete_workspace", map[string]any{"workspaceId": "w"}, true)
		if result["status"] != float64(403) {
			t.Fatal(result)
		}
	}
	denied := managementCall(t, world, "zoe", "blok_delete_workspace", map[string]any{"workspaceId": "equipe"}, true)
	if denied["status"] != float64(404) {
		t.Fatal("deletion must use an exact workspace ID", denied)
	}
	var count int
	if err := world.service.DB.QueryRow(world.ctx, `SELECT count(*) FROM workspaces WHERE id='w'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("refused deletion changed workspace", err)
	}
}

func TestMCPDeleteWorkspaceRemovesItsContentsAndKeepsOtherWorkspaceAndAccounts(t *testing.T) {
	world := workspaceDeletionAdmin(t)
	if _, err := world.service.DB.Exec(world.ctx, `
 INSERT INTO workspaces(id,slug,name) VALUES('keep','keep','Keep');
 INSERT INTO memberships(workspace_id,user_id,role) VALUES('keep','alice','member'),('keep','zoe','admin');
 INSERT INTO pages(id,workspace_id,metadata,visibility,content) VALUES('keep-page','keep','{"id":"keep-page","title":"Keep"}','workspace','{"blocks":[]}');
 INSERT INTO teamspaces(id,workspace_id,name) VALUES('team','w','Team');
 INSERT INTO teamspace_memberships(teamspace_id,workspace_id,user_id,role) VALUES('team','w','zoe','owner');
 INSERT INTO invites(id,workspace_id,email,role,expires_at) VALUES('invite','w','new@example.test','member',now()+interval '1 day');
 INSERT INTO join_requests(id,workspace_id,user_id) VALUES('request','w','zoe');
 INSERT INTO workspace_emojis(id,workspace_id,name,url,created_by) VALUES('emoji','w','logo','/files/secret.png','bob');
 INSERT INTO ai_credentials(scope,owner_id,model) VALUES('workspace','w','test'),('personal','bob','personal');
 INSERT INTO row_body_migrations(source_id,workspace_id,state,source_before,source_after,body_pages) VALUES('public','w','complete','{}','{}','[]');
 INSERT INTO row_body_creations(document_id,row_id,body_id,plan,complete) VALUES('prive','row','enfant','{}',true);
 INSERT INTO row_body_drafts(user_id,document_id,row_id,operation_id,digest,body_id,plan) VALUES('bob','prive','row','draft','digest','enfant','{}');
 INSERT INTO page_placements(page_id,plan) VALUES('public','{}');
 INSERT INTO page_create_requests(workspace_id,user_id,request_id,digest,page_id,result,operation_id) VALUES('w','bob','request','digest','enfant','{}','operation');
 UPDATE instance_settings SET default_workspace_id='w';
 `); err != nil {
		t.Fatal(err)
	}
	if err := world.service.refreshSettings(world.ctx); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(world.service.Config.DataDirectory, "uploads")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"secret.png", "commun.png", "keep.png"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := world.service.DB.Exec(world.ctx, `INSERT INTO assets(name,workspace_id) VALUES('keep.png','keep')`); err != nil {
		t.Fatal(err)
	}
	result := managementCall(t, world, "zoe", "blok_delete_workspace", map[string]any{"workspaceId": "w"}, false)
	if result["id"] != "w" || result["deleted"] != true || result["cleanupComplete"] != true {
		t.Fatal(result)
	}
	for _, query := range []string{
		`SELECT count(*) FROM row_body_migrations WHERE workspace_id='w'`,
		`SELECT count(*) FROM row_body_creations`, `SELECT count(*) FROM row_body_drafts`, `SELECT count(*) FROM page_placements`, `SELECT count(*) FROM page_create_requests WHERE workspace_id='w'`,
		`SELECT count(*) FROM workspaces WHERE id='w'`, `SELECT count(*) FROM memberships WHERE workspace_id='w'`,
		`SELECT count(*) FROM pages WHERE workspace_id='w'`, `SELECT count(*) FROM assets WHERE workspace_id='w'`,
		`SELECT count(*) FROM teamspaces WHERE workspace_id='w'`, `SELECT count(*) FROM teamspace_memberships WHERE workspace_id='w'`,
		`SELECT count(*) FROM invites WHERE workspace_id='w'`, `SELECT count(*) FROM join_requests WHERE workspace_id='w'`,
		`SELECT count(*) FROM workspace_emojis WHERE workspace_id='w'`, `SELECT count(*) FROM ai_credentials WHERE scope='workspace' AND owner_id='w'`,
	} {
		var n int
		if err := world.service.DB.QueryRow(world.ctx, query).Scan(&n); err != nil || n != 0 {
			t.Fatalf("not removed: %s n=%d err=%v", query, n, err)
		}
	}
	for _, query := range []string{`SELECT count(*) FROM workspaces WHERE id='keep'`, `SELECT count(*) FROM pages WHERE id='keep-page'`, `SELECT count(*) FROM ai_credentials WHERE scope='personal' AND owner_id='bob'`, `SELECT count(*) FROM instance_admins WHERE user_id='zoe'`} {
		var n int
		if err := world.service.DB.QueryRow(world.ctx, query).Scan(&n); err != nil || n != 1 {
			t.Fatalf("other scope changed: %s n=%d err=%v", query, n, err)
		}
	}
	var accounts int
	if err := world.service.DB.QueryRow(world.ctx, `SELECT count(*) FROM users`).Scan(&accounts); err != nil || accounts != 3 {
		t.Fatal("accounts removed", accounts, err)
	}
	if world.service.settings().DefaultWorkspaceID != nil {
		t.Fatal("deleted default remains cached")
	}
	if _, err := os.Stat(filepath.Join(directory, "secret.png")); !os.IsNotExist(err) {
		t.Fatal("deleted workspace asset remains", err)
	}
	if _, err := os.Stat(filepath.Join(directory, "keep.png")); err != nil {
		t.Fatal("other workspace file removed", err)
	}
	// Idempotent retries do not depend on a membership or on the vanished row.
	managementCall(t, world, "zoe", "blok_delete_workspace", map[string]any{"workspaceId": "w"}, false)
}

func TestMCPDeleteWorkspaceWorksWithNoMembers(t *testing.T) {
	world := workspaceDeletionAdmin(t)
	if _, err := world.service.DB.Exec(world.ctx, `DELETE FROM page_shares;DELETE FROM memberships WHERE workspace_id='w'`); err != nil {
		t.Fatal(err)
	}
	result := managementCall(t, world, "zoe", "blok_delete_workspace", map[string]any{"workspaceId": "w"}, false)
	if result["deleted"] != true {
		t.Fatal(result)
	}
}

func TestMCPDeleteWorkspaceAdvertisesDestructiveOperation(t *testing.T) {
	world := workspaceDeletionAdmin(t)
	cap := managementCall(t, world, "zoe", "blok_capabilities", map[string]any{}, false)
	encoded, _ := json.Marshal(cap)
	if !strings.Contains(string(encoded), "blok_delete_workspace") {
		t.Fatal("workspace deletion missing from capabilities")
	}
	req, err := http.NewRequest("POST", world.server.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer management-zoe")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "data: ") {
		data = []byte(strings.SplitN(strings.SplitN(string(data), "data: ", 2)[1], "\n", 2)[0])
	}
	var envelope struct {
		Result struct {
			Tools []struct {
				Name        string
				Annotations struct {
					DestructiveHint bool
					ReadOnlyHint    bool
				}
			}
		}
	}
	if err = json.Unmarshal(data, &envelope); err != nil {
		t.Fatal(err)
	}
	for _, tool := range envelope.Result.Tools {
		if tool.Name == "blok_delete_workspace" {
			if !tool.Annotations.DestructiveHint || tool.Annotations.ReadOnlyHint {
				t.Fatal("deletion tool incorrectly annotated", tool)
			}
			return
		}
	}
	t.Fatal("deletion tool missing from tools/list")
}

func TestDeleteWorkspaceRESTKeepsMCPTokenOutOfREST(t *testing.T) {
	world := workspaceDeletionAdmin(t)
	managementCall(t, world, "zoe", "blok_capabilities", map[string]any{}, false)
	world.send(t, "DELETE", "management-zoe", "/api/admin/workspaces/w", nil, 401)
	world.send(t, "DELETE", tokenAlice, "/api/admin/workspaces/w", nil, 403)
	world.send(t, "DELETE", tokenZoe, "/api/admin/workspaces/w", nil, 200)
}

func TestMCPDeleteWorkspaceRevokesAnOpenDocument(t *testing.T) {
	world := workspaceDeletionAdmin(t)
	// A live MCP handle must not keep authority after workspace deletion.
	opened := managementCall(t, world, "alice", "blok_open", map[string]any{"documentId": "public", "write": true}, false)
	handle, _ := opened["handle"].(string)
	if handle == "" {
		t.Fatal("missing document handle", opened)
	}

	managementCall(t, world, "alice", "blok_read", map[string]any{"handle": handle}, false)
	pass := world.send(t, "GET", tokenAlice, "/api/blok-ticket?doc=public", nil, 200)["ticket"].(string)
	cfg, err := websocket.NewConfig(strings.Replace(world.server.URL, "http://", "ws://", 1)+"/api/blok/sync/public", world.service.Config.PublicURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Protocol = []string{"blok-sync.v2", pass}
	conn, err := websocket.DialConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var initial []byte
	if err = websocket.Message.Receive(conn, &initial); err != nil {
		t.Fatal(err)
	}
	managementCall(t, world, "zoe", "blok_delete_workspace", map[string]any{"workspaceId": "w"}, false)
	managementCall(t, world, "alice", "blok_read", map[string]any{"handle": handle}, true)
	managementCall(t, world, "alice", "blok_close", map[string]any{"handle": handle}, true)
	world.assertMCPPage(t, "alice", "public", false, false)
	world.send(t, "GET", tokenAlice, "/api/blok-ticket?doc=public", nil, 403)
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var frame []byte
		err = websocket.Message.Receive(conn, &frame)
		if err != nil {
			if n, ok := err.(net.Error); ok && n.Timeout() {
				t.Fatal("deleted workspace left admitted socket open")
			}
			break
		}
	}
	result, err := world.service.Blok.PurgeDocument(context.Background(), "public", func(context.Context) (bool, error) { return true, nil })
	if err != nil {
		t.Fatal("document purge was not idempotent", result, err)
	}
}

func TestMCPDeleteWorkspaceResumesFileCleanupAfterFailure(t *testing.T) {
	world := workspaceDeletionAdmin(t)
	// A nonempty directory at the upload filename makes unlink fail reliably,
	// even inside the root-owned Docker test container.
	blocked := filepath.Join(world.service.Config.DataDirectory, "uploads", "secret.png")
	if err := os.MkdirAll(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocked, "blocker"), []byte("block"), 0600); err != nil {
		t.Fatal(err)
	}
	result := managementCall(t, world, "zoe", "blok_delete_workspace", map[string]any{"workspaceId": "w"}, true)
	if result["status"] != float64(503) {
		t.Fatal(result)
	}
	details, ok := result["error"].(map[string]any)["details"].(map[string]any)
	if !ok {
		t.Fatal("missing cleanup recovery details", result)
	}
	if details["workspaceId"] != "w" || details["deleted"] != true || details["cleanupComplete"] != false || details["retry"] != true {
		t.Fatal(result)
	}
	var remaining, documents int
	var complete bool
	if err := world.service.DB.QueryRow(world.ctx, `SELECT (SELECT count(*) FROM workspaces WHERE id='w'),jsonb_array_length(document_ids),completed_at IS NOT NULL FROM workspace_deletions WHERE workspace_id='w'`).Scan(&remaining, &documents, &complete); err != nil || remaining != 0 || documents != 0 || complete {
		t.Fatal("cleanup receipt not preserved", remaining, documents, complete, err)
	}
	if err := os.RemoveAll(blocked); err != nil {
		t.Fatal(err)
	}
	result = managementCall(t, world, "zoe", "blok_delete_workspace", map[string]any{"workspaceId": "w"}, false)
	if result["cleanupComplete"] != true {
		t.Fatal(result)
	}
	if err := world.service.DB.QueryRow(world.ctx, `SELECT completed_at IS NOT NULL AND document_ids='[]'::jsonb AND asset_names='[]'::jsonb FROM workspace_deletions WHERE workspace_id='w'`).Scan(&complete); err != nil || !complete {
		t.Fatal("cleanup never completed", err)
	}
}

func TestMCPDeleteWorkspaceDoesNotRecreateBootstrapOnRestart(t *testing.T) {
	world := workspaceDeletionAdmin(t)
	if _, err := world.service.DB.Exec(world.ctx, `UPDATE instance_settings SET setup_completed_at=now()`); err != nil {
		t.Fatal(err)
	}
	managementCall(t, world, "zoe", "blok_delete_workspace", map[string]any{"workspaceId": "w"}, false)
	cfg := world.service.Config
	cfg.AdminEmail = "zoe@example.test"
	cfg.BootstrapWorkspaceSlug = "equipe"
	cfg.BootstrapWorkspaceName = "Equipe"
	restarted, err := New(world.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	var count int
	if err = restarted.DB.QueryRow(world.ctx, `SELECT count(*) FROM workspaces`).Scan(&count); err != nil || count != 0 {
		t.Fatal("deleted bootstrap workspace recreated", count, err)
	}
	var completed bool
	if err = restarted.DB.QueryRow(world.ctx, `SELECT setup_completed_at IS NOT NULL FROM instance_settings`).Scan(&completed); err != nil || !completed {
		t.Fatal("deleting last workspace reopened setup", err)
	}
}

func TestMCPDeleteWorkspaceRollsBackAllSQLOnFailure(t *testing.T) {
	world := workspaceDeletionAdmin(t)
	if _, err := world.service.DB.Exec(world.ctx, `
 UPDATE instance_settings SET default_workspace_id='w';
 CREATE FUNCTION refuse_workspace_delete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected failure';END$$;
 CREATE TRIGGER refuse_workspace_delete BEFORE DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION refuse_workspace_delete();
 `); err != nil {
		t.Fatal(err)
	}
	result := managementCall(t, world, "zoe", "blok_delete_workspace", map[string]any{"workspaceId": "w"}, true)
	if result["status"] != float64(503) {
		t.Fatal(result)
	}
	for _, query := range []string{`SELECT count(*)=1 FROM workspaces WHERE id='w'`, `SELECT count(*)=3 FROM memberships WHERE workspace_id='w'`, `SELECT count(*)=3 FROM pages WHERE workspace_id='w'`, `SELECT count(*)=2 FROM assets WHERE workspace_id='w'`, `SELECT count(*)=0 FROM workspace_deletions`, `SELECT default_workspace_id='w' FROM instance_settings`} {
		var unchanged bool
		if err := world.service.DB.QueryRow(world.ctx, query).Scan(&unchanged); err != nil || !unchanged {
			t.Fatal("partial deletion after SQL failure", query, err)
		}
	}
}
