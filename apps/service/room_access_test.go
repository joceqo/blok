package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"time"

	"github.com/JackUait/blok/packages/server/go/v2/blokserver/ticket"
	"net/http"
	"testing"
)

func TestTrustedRoomChecksCurrentSessionAndPage(t *testing.T) {
	world := newReadsWorld(t)
	type decision struct{ Read, Write bool }
	check := func(secret, session, doc string, status int) decision {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"session": session, "documentId": doc})
		req, _ := http.NewRequest("POST", world.server.URL+"/internal/room-access", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+secret)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != status {
			t.Fatalf("status %d, expected %d", resp.StatusCode, status)
		}
		var out decision
		if status == 200 {
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				t.Fatal(err)
			}
		}
		return out
	}
	secret := world.service.Config.InternalSecret
	check("wrong", hash(tokenBob), "prive", 401)
	check(secret, "not-a-digest", "prive", 400)
	if got := check(secret, hash(tokenBob), "prive", 200); got != (decision{true, true}) {
		t.Fatalf("owner: %+v", got)
	}
	if got := check(secret, hash(tokenAlice), "prive", 200); got != (decision{}) {
		t.Fatalf("unshared: %+v", got)
	}
	world.send(t, "PUT", tokenBob, "/api/workspaces/equipe/pages/prive/shares/alice", map[string]any{"level": "view"}, 200)
	if got := check(secret, hash(tokenAlice), "prive", 200); got != (decision{true, false}) {
		t.Fatalf("viewer: %+v", got)
	}
	world.send(t, "PUT", tokenBob, "/api/workspaces/equipe/pages/prive/shares/alice", map[string]any{"level": "edit"}, 200)
	if got := check(secret, hash(tokenAlice), "prive", 200); got != (decision{true, true}) {
		t.Fatalf("editor: %+v", got)
	}
	world.send(t, "DELETE", tokenBob, "/api/workspaces/equipe/pages/prive/shares/alice", nil, 200)
	if got := check(secret, hash(tokenAlice), "prive", 200); got != (decision{}) {
		t.Fatalf("revoked: %+v", got)
	}
	if _, err := world.service.DB.Exec(world.ctx, "UPDATE pages SET trashed=true WHERE id='prive'"); err != nil {
		t.Fatal(err)
	}
	if got := check(secret, hash(tokenBob), "prive", 200); got != (decision{}) {
		t.Fatalf("trash: %+v", got)
	}
	if _, err := world.service.DB.Exec(world.ctx, "UPDATE sessions SET expires_at=now() WHERE id=$1", hash(tokenBob)); err != nil {
		t.Fatal(err)
	}
	if got := check(secret, hash(tokenBob), "public", 200); got != (decision{}) {
		t.Fatalf("expired: %+v", got)
	}
}

func TestRoomAdmissionUsesTheShellTicket(t *testing.T) {
	world := newReadsWorld(t)
	secret := world.service.Config.InternalSecret
	call := func(payload map[string]string, status int) map[string]any {
		t.Helper()
		data, _ := json.Marshal(payload)
		req, _ := http.NewRequest("POST", world.server.URL+"/internal/room-access", bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+secret)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != status {
			t.Fatalf("expected %d, received %d", status, resp.StatusCode)
		}
		var out map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	doc := "prive"
	active := world.send(t, "GET", tokenBob, "/api/workspaces/equipe/ticket?doc=prive", nil, 200)["ticket"].(string)
	grant := call(map[string]string{"ticket": active, "documentId": doc}, 200)
	if grant["session"] != hash(tokenBob) || grant["write"] != true || grant["ticketWrite"] != true {
		t.Fatalf("grant %+v", grant)
	}
	call(map[string]string{"ticket": active, "documentId": "other"}, 401)
	call(map[string]string{"ticket": "invalid", "documentId": doc}, 401)
	call(map[string]string{"ticket": active, "session": hash(tokenBob), "documentId": doc}, 400)
	ttl := int64(1)
	expired, err := ticket.Mint(world.service.Config.TicketSecret, ticket.Claims{User: hash(tokenBob), Doc: &doc, Write: true, TTLSeconds: &ttl}, time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	call(map[string]string{"ticket": expired, "documentId": doc}, 401)
	readOnly, err := ticket.Mint(world.service.Config.TicketSecret, ticket.Claims{User: hash(tokenBob), Doc: &doc, Write: false}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	grant = call(map[string]string{"ticket": readOnly, "documentId": doc}, 200)
	if grant["write"] != false || grant["ticketWrite"] != false || grant["read"] != true {
		t.Fatalf("ticket ceiling lost: %+v", grant)
	}
}

// Run against a bundled Node room on a fresh private Go service and DB schema.
func TestNodeRoomAgainstCanonicalACL(t *testing.T) {
	scenario := os.Getenv("BLOK_TEST_NODE_ROOM_SCENARIO")
	if scenario == "" {
		t.Skip("set BLOK_TEST_NODE_ROOM_SCENARIO to the Node shell-room ACL scenario")
	}
	world := newReadsWorld(t)
	ctx, cancel := context.WithTimeout(world.ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", scenario)
	payload, _ := json.Marshal(map[string]string{"origin": world.server.URL, "secret": world.service.Config.InternalSecret, "owner": tokenBob, "member": tokenAlice})
	cmd.Stdin = bytes.NewReader(payload)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node room scenario: %v\n%s", err, output)
	}
	t.Log(string(output))
}
