package cloud

import "testing"

// A workspace admin can grant access to someone who already has an account.
// Until now the only route in was an invitation, which becomes a membership
// only when the person signs in — so an admin could not finish setting up a
// workspace (person properties, assignments) before the team showed up.
func TestAddExistingAccountAsMember(t *testing.T) {
	w := newReadsWorld(t)
	if _, e := w.service.DB.Exec(w.ctx, `INSERT INTO users(id,email) VALUES('dan','dan@example.test')`); e != nil {
		t.Fatal(e)
	}

	added := w.send(t, "POST", tokenZoe, "/api/workspaces/equipe/members", map[string]any{"email": "dan@example.test", "role": "member"}, 201)
	if added["added"] != true || added["invited"] != false {
		t.Fatalf("expected a membership, got %v", added)
	}
	var role string
	if e := w.service.DB.QueryRow(w.ctx, `SELECT role FROM memberships WHERE workspace_id='w' AND user_id='dan'`).Scan(&role); e != nil || role != "member" {
		t.Fatalf("membership missing: %v %q", e, role)
	}

	// Re-running must not duplicate the membership nor silently change the role.
	w.send(t, "POST", tokenZoe, "/api/workspaces/equipe/members", map[string]any{"email": "dan@example.test", "role": "member"}, 409)

	// Only admins, and only valid roles.
	w.send(t, "POST", tokenAlice, "/api/workspaces/equipe/members", map[string]any{"email": "dan@example.test", "role": "member"}, 403)
	// An administrator is promoted afterwards: invitations cannot carry that role,
	// so refusing it here keeps the answer identical for a known and unknown address.
	w.send(t, "POST", tokenZoe, "/api/workspaces/equipe/members", map[string]any{"email": "dan@example.test", "role": "admin"}, 400)
	w.send(t, "POST", tokenZoe, "/api/workspaces/equipe/members", map[string]any{"email": "dan@example.test", "role": "owner"}, 400)
	w.send(t, "POST", tokenZoe, "/api/workspaces/equipe/members", map[string]any{"email": "pas-un-email", "role": "member"}, 400)
}

// Whether an email already has an account must not be observable: an unknown
// address yields the same 201, as a pending invitation rather than an error.
func TestAddingAnUnknownAddressInvitesInsteadOfLeaking(t *testing.T) {
	w := newReadsWorld(t)

	out := w.send(t, "POST", tokenZoe, "/api/workspaces/equipe/members", map[string]any{"email": "inconnu@example.test", "role": "viewer"}, 201)
	if out["added"] != false || out["invited"] != true {
		t.Fatalf("expected an invitation, got %v", out)
	}
	var status, role string
	if e := w.service.DB.QueryRow(w.ctx, `SELECT status,role FROM invites WHERE workspace_id='w' AND email='inconnu@example.test'`).Scan(&status, &role); e != nil {
		t.Fatal(e)
	}
	if status != "pending" || role != "viewer" {
		t.Fatalf("invitation %q/%q", status, role)
	}
}

// Someone invited earlier, who has since created an account, must not keep a
// stale pending invitation once they are a member: signing in would otherwise
// replay it and could reset the role the admin just chose.
func TestAddingAMemberConsumesTheirPendingInvitation(t *testing.T) {
	w := newReadsWorld(t)
	if _, e := w.service.DB.Exec(w.ctx, `
		INSERT INTO users(id,email) VALUES('eve','eve@example.test');
		INSERT INTO invites(id,workspace_id,email,role,expires_at) VALUES('inv','w','eve@example.test','viewer',now()+interval '7 days')`); e != nil {
		t.Fatal(e)
	}

	w.send(t, "POST", tokenZoe, "/api/workspaces/equipe/members", map[string]any{"email": "eve@example.test", "role": "member"}, 201)

	var pending int
	if e := w.service.DB.QueryRow(w.ctx, `SELECT count(*) FROM invites WHERE workspace_id='w' AND email='eve@example.test' AND status='pending'`).Scan(&pending); e != nil {
		t.Fatal(e)
	}
	if pending != 0 {
		t.Fatalf("%d pending invitations left", pending)
	}
}
