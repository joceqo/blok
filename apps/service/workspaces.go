package cloud

import (
	"context"
	"net/http"
	"regexp"
	"time"
	"unicode/utf8"
)

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)

func (s *Service) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	u, ok := s.require(w, r)
	if !ok {
		return
	}
	list, e := s.workspaces(r.Context(), u.ID)
	if e != nil {
		failed(w, 503, "Database unavailable", e)
		return
	}
	jsonOut(w, 200, map[string]any{"workspaces": list})
}
func (s *Service) createWorkspace(w http.ResponseWriter, r *http.Request) {
	u, ok := s.require(w, r)
	if !ok {
		return
	}
	switch s.settings().WorkspaceCreation {
	case "disabled":
		problem(w, 403, "Workspace creation is disabled on this instance")
		return
	case "admins_only":
		if !u.InstanceAdmin {
			problem(w, 403, "Instance administrator required")
			return
		}
	}
	s.insertWorkspace(w, r, u)
}

// createAdminWorkspace lets instance admins create a workspace even when
// WorkspaceCreation is disabled (B5/B6).
func (s *Service) createAdminWorkspace(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireInstanceAdmin(w, r)
	if !ok {
		return
	}
	s.insertWorkspace(w, r, u)
}

func (s *Service) insertWorkspace(w http.ResponseWriter, r *http.Request, u identity) {
	var in struct {
		Name string `json:"name"`
		Slug string `json:"slug"`
	}
	if !body(w, r, &in) {
		return
	}
	if !slugPattern.MatchString(in.Slug) || len(in.Name) < 1 || len(in.Name) > 120 {
		problem(w, 400, "Invalid workspace name or slug")
		return
	}
	if !s.rate(r.Context(), "workspace:"+u.ID, 10) {
		problem(w, 429, "Too many workspaces")
		return
	}
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		failed(w, 503, "Database unavailable", e)
		return
	}
	defer tx.Rollback(r.Context())
	out := Workspace{ID: opaque(), Slug: in.Slug, Name: in.Name, Role: "admin", AllowNotificationMail: true}
	if _, e = tx.Exec(r.Context(), "INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3)", out.ID, out.Slug, out.Name); e != nil {
		problem(w, 409, "Slug already used")
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO memberships VALUES($1,$2,'admin')", out.ID, u.ID); e != nil {
		failed(w, 500, "Creation failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		failed(w, 500, "Creation failed", e)
		return
	}
	var n int
	if s.DB.QueryRow(r.Context(), `SELECT count(*) FROM workspaces`).Scan(&n) == nil && n == 1 {
		id := out.ID
		_, _ = s.applySettings(r.Context(), SettingsPatch{DefaultWorkspaceID: &id, UpdatedBy: &u.ID})
	}
	jsonOut(w, 201, out)
}
func (s *Service) lookupWorkspace(ctx context.Context, slug, user string) (Workspace, error) {
	var out Workspace
	e := s.DB.QueryRow(ctx, `SELECT w.id,w.slug,w.name,w.icon,w.allow_notification_mail,coalesce(m.role,'') FROM workspaces w
		LEFT JOIN memberships m ON m.workspace_id=w.id AND m.user_id=$2
		WHERE w.slug=$1 OR w.id=$1 ORDER BY (w.slug=$1) DESC LIMIT 1`, slug, user).Scan(&out.ID, &out.Slug, &out.Name, &out.Icon, &out.AllowNotificationMail, &out.Role)
	return out, e
}
func (s *Service) workspace(w http.ResponseWriter, r *http.Request) {
	if r.Method == "PATCH" {
		s.renameWorkspace(w, r)
		return
	}
	if r.Method != "GET" {
		problem(w, 405, "Method not allowed")
		return
	}
	u, _ := s.session(r)
	ws, e := s.lookupWorkspace(r.Context(), r.PathValue("slug"), u.ID)
	if e != nil {
		problem(w, 404, "Workspace not found")
		return
	}
	var status *string
	if u.ID != "" {
		var st string
		if s.DB.QueryRow(r.Context(), "SELECT status FROM join_requests WHERE workspace_id=$1 AND user_id=$2", ws.ID, u.ID).Scan(&st) == nil {
			status = &st
		}
	}
	var role *string
	if ws.Role != "" {
		role = &ws.Role
	}
	jsonOut(w, 200, map[string]any{"id": ws.ID, "slug": ws.Slug, "name": ws.Name, "role": role, "joinStatus": status, "icon": ws.Icon, "allowNotificationMail": ws.AllowNotificationMail})
}
func (s *Service) renameWorkspace(w http.ResponseWriter, r *http.Request) {
	u, ok := s.require(w, r)
	if !ok {
		return
	}
	ws, e := s.lookupWorkspace(r.Context(), r.PathValue("slug"), u.ID)
	if e != nil {
		problem(w, 404, "Workspace not found")
		return
	}
	if ws.Role != "admin" {
		problem(w, 403, "Administrator required")
		return
	}
	var in struct {
		Name                  *string `json:"name"`
		Icon                  *string `json:"icon"`
		AllowNotificationMail *bool   `json:"allowNotificationMail"`
	}
	if !body(w, r, &in) {
		return
	}
	// Chaque champ est facultatif, mais un corps qui ne demande rien est une
	// erreur d'appel : l'ecrire quand meme reviendrait a deviner l'intention.
	if in.Name == nil && in.Icon == nil && in.AllowNotificationMail == nil {
		problem(w, 400, "Nothing to change")
		return
	}
	// Memes bornes qu'a la creation : un nom renommable doit rester creable.
	if in.Name != nil && (len(*in.Name) < 1 || len(*in.Name) > 120) {
		problem(w, 400, "Invalid workspace name")
		return
	}
	// Le slug n'est pas touche : il porte l'URL de l'espace, et le bootstrap
	// recreerait un espace vide si le sien disparaissait. La revision non plus,
	// elle arbitre les ecritures concurrentes de l'index des pages.
	if in.Icon != nil && !validWorkspaceIcon(*in.Icon) {
		problem(w, 400, "Invalid workspace icon")
		return
	}
	name, icon, allowed := ws.Name, ws.Icon, ws.AllowNotificationMail
	if in.Name != nil {
		name = *in.Name
	}
	if in.Icon != nil {
		icon = *in.Icon
	}
	if in.AllowNotificationMail != nil {
		allowed = *in.AllowNotificationMail
	}
	if _, e = s.DB.Exec(r.Context(), "UPDATE workspaces SET name=$1,icon=$2,allow_notification_mail=$3 WHERE id=$4", name, icon, allowed, ws.ID); e != nil {
		failed(w, 503, "Database unavailable", e)
		return
	}
	jsonOut(w, 200, map[string]any{"id": ws.ID, "slug": ws.Slug, "name": name, "role": ws.Role, "icon": icon, "allowNotificationMail": allowed})
}
func (s *Service) workspaceResource(w http.ResponseWriter, r *http.Request) {
	u, ok := s.require(w, r)
	if !ok {
		return
	}
	ws, e := s.lookupWorkspace(r.Context(), r.PathValue("slug"), u.ID)
	if e != nil {
		problem(w, 404, "Workspace not found")
		return
	}
	resource := r.PathValue("resource")
	id := r.PathValue("id")
	action := r.PathValue("action")
	if resource == "join-requests" && r.Method == "POST" && id == "" {
		if ws.Role != "" {
			jsonOut(w, 200, map[string]any{"ok": true, "status": "approved"})
			return
		}
		var in struct {
			Message string `json:"message"`
		}
		if !body(w, r, &in) {
			return
		}
		if len(in.Message) > 2000 {
			problem(w, 400, "Message too long")
			return
		}
		_, e = s.DB.Exec(r.Context(), `INSERT INTO join_requests(id,workspace_id,user_id,message) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,user_id) DO UPDATE SET message=$4,status='pending',created_at=now()`, opaque(), ws.ID, u.ID, in.Message)
		if e != nil {
			failed(w, 500, "Request failed", e)
			return
		}
		jsonOut(w, 200, map[string]any{"ok": true, "status": "pending"})
		return
	}
	if ws.Role == "" {
		problem(w, 403, "Workspace membership required")
		return
	}
	switch resource {
	case "import":
		if action != "" {
			http.NotFound(w, r)
			return
		}
		s.importWorkspace(w, r, u, ws, id)
		return
	case "export":
		if r.Method != http.MethodGet {
			problem(w, 405, "Method not allowed")
			return
		}
		switch {
		case id == "index" && action == "":
			s.index(w, r, u, ws)
		case id == "pages" && action != "" && r.PathValue("target") == "":
			s.exportPage(w, r, u, ws, action)
		default:
			problem(w, 404, "Not found")
		}
		return
	case "emojis":
		s.emojis(w, r, u, ws, id)
		return
	case "images":
		s.workspaceImage(w, r, ws, id)
		return
	case "ai":
		s.ai(w, r, u, ws, id)
		return
	case "index":
		s.index(w, r, u, ws)
		return
	case "pages":
		s.page(w, r, u, ws)
		return
	case "ticket":
		s.ticket(w, r, u, ws, id)
		return
	case "members":
		if r.Method == "GET" && id == "" {
			s.members(w, r, ws)
			return
		}
	}
	if ws.Role != "admin" {
		problem(w, 403, "Administrator required")
		return
	}
	switch resource {
	case "members":
		s.mutateMember(w, r, u, ws, id)
	case "join-requests":
		s.joinRequests(w, r, ws, id, action)
	case "invites":
		s.invites(w, r, u, ws, id)
	default:
		problem(w, 404, "Not found")
	}
}
func (s *Service) members(w http.ResponseWriter, r *http.Request, ws Workspace) {
	rows, e := s.DB.Query(r.Context(), "SELECT u.id,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.email", ws.ID)
	if e != nil {
		failed(w, 503, "Database unavailable", e)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, email, role string
		if e = rows.Scan(&id, &email, &role); e != nil {
			failed(w, 500, "Read failed", e)
			return
		}
		out = append(out, map[string]any{"id": id, "email": email, "role": role})
	}
	if rows.Err() != nil {
		failed(w, 500, "Read failed", rows.Err())
		return
	}
	jsonOut(w, 200, map[string]any{"members": out})
}
func (s *Service) mutateMember(w http.ResponseWriter, r *http.Request, u identity, ws Workspace, id string) {
	if (r.Method != "PATCH" && r.Method != "DELETE") || id == "" {
		problem(w, 405, "Method not allowed")
		return
	}
	var in struct {
		Role string `json:"role"`
	}
	if r.Method == "PATCH" {
		if !body(w, r, &in) {
			return
		}
		if in.Role != "admin" && in.Role != "member" && in.Role != "viewer" {
			problem(w, 400, "Invalid role")
			return
		}
	}
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		failed(w, 503, "Database unavailable", e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", ws.ID); e != nil {
		failed(w, 500, "Update failed", e)
		return
	}
	var caller string
	if e = tx.QueryRow(r.Context(), "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2", ws.ID, u.ID).Scan(&caller); e != nil || caller != "admin" {
		problem(w, 403, "Administrator required")
		return
	}
	var old string
	if e = tx.QueryRow(r.Context(), "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2", ws.ID, id).Scan(&old); e != nil {
		problem(w, 404, "Member not found")
		return
	}
	if old == "admin" && in.Role != "admin" {
		var count int
		if e = tx.QueryRow(r.Context(), "SELECT count(*) FROM memberships WHERE workspace_id=$1 AND role='admin'", ws.ID).Scan(&count); e != nil {
			failed(w, 500, "Update failed", e)
			return
		}
		if count <= 1 {
			problem(w, 409, "Keep at least one administrator")
			return
		}
	}
	if r.Method == "DELETE" {
		// « Qui a accès » doit dire la vérité : un partage laissé derrière
		// quelqu'un qui a quitté l'espace ressusciterait à son retour.
		if _, e = tx.Exec(r.Context(), "DELETE FROM page_shares sh USING pages p WHERE sh.page_id=p.id AND p.workspace_id=$1 AND sh.user_id=$2", ws.ID, id); e != nil {
			failed(w, 500, "Update failed", e)
			return
		}
		_, e = tx.Exec(r.Context(), "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2", ws.ID, id)
	} else {
		_, e = tx.Exec(r.Context(), "UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2", ws.ID, id, in.Role)
	}
	if e != nil {
		failed(w, 500, "Update failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		failed(w, 500, "Update failed", e)
		return
	}
	s.recheckWorkspace(r.Context(), ws.ID)
	jsonOut(w, 200, map[string]bool{"ok": true})
}
func (s *Service) joinRequests(w http.ResponseWriter, r *http.Request, ws Workspace, id, action string) {
	if r.Method == "GET" && id == "" {
		rows, e := s.DB.Query(r.Context(), "SELECT j.id,j.user_id,u.email,j.message,j.status,j.created_at FROM join_requests j JOIN users u ON u.id=j.user_id WHERE j.workspace_id=$1 ORDER BY j.created_at DESC", ws.ID)
		if e != nil {
			failed(w, 503, "Database unavailable", e)
			return
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var id, uid, email, msg, status string
			var created time.Time
			if e = rows.Scan(&id, &uid, &email, &msg, &status, &created); e != nil {
				failed(w, 500, "Read failed", e)
				return
			}
			out = append(out, map[string]any{"id": id, "userId": uid, "email": email, "message": msg, "status": status, "createdAt": created})
		}
		if rows.Err() != nil {
			failed(w, 500, "Read failed", rows.Err())
			return
		}
		jsonOut(w, 200, map[string]any{"requests": out})
		return
	}
	if r.Method != "POST" || id == "" || (action != "approve" && action != "reject") {
		problem(w, 405, "Method not allowed")
		return
	}
	var in struct {
		Role string `json:"role"`
	}
	if !body(w, r, &in) {
		return
	}
	if in.Role == "" {
		in.Role = "member"
	}
	if in.Role != "member" && in.Role != "viewer" {
		problem(w, 400, "Invalid role")
		return
	}
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		failed(w, 503, "Database unavailable", e)
		return
	}
	defer tx.Rollback(r.Context())
	var uid string
	e = tx.QueryRow(r.Context(), "SELECT user_id FROM join_requests WHERE id=$1 AND workspace_id=$2 AND status='pending' FOR UPDATE", id, ws.ID).Scan(&uid)
	if e != nil {
		problem(w, 404, "Pending request not found")
		return
	}
	status := "rejected"
	if action == "approve" {
		status = "approved"
		if _, e = tx.Exec(r.Context(), "INSERT INTO memberships VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO NOTHING", ws.ID, uid, in.Role); e != nil {
			failed(w, 500, "Approval failed", e)
			return
		}
	}
	if _, e = tx.Exec(r.Context(), "UPDATE join_requests SET status=$2 WHERE id=$1", id, status); e != nil {
		failed(w, 500, "Update failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		failed(w, 500, "Update failed", e)
		return
	}
	jsonOut(w, 200, map[string]bool{"ok": true})
}
func (s *Service) invites(w http.ResponseWriter, r *http.Request, u identity, ws Workspace, id string) {
	if r.Method == "GET" && id == "" {
		rows, e := s.DB.Query(r.Context(), "SELECT id,email,role,status,expires_at FROM invites WHERE workspace_id=$1 ORDER BY created_at DESC", ws.ID)
		if e != nil {
			failed(w, 503, "Database unavailable", e)
			return
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var id, email, role, status string
			var expiry time.Time
			if e := rows.Scan(&id, &email, &role, &status, &expiry); e != nil {
				failed(w, 500, "Read failed", e)
				return
			}
			out = append(out, map[string]any{"id": id, "email": email, "role": role, "status": status, "expiresAt": expiry})
		}
		if rows.Err() != nil {
			failed(w, 500, "Read failed", rows.Err())
			return
		}
		jsonOut(w, 200, map[string]any{"invites": out})
		return
	}
	if r.Method == "DELETE" && id != "" {
		tag, e := s.DB.Exec(r.Context(), "UPDATE invites SET status='revoked' WHERE id=$1 AND workspace_id=$2 AND status='pending'", id, ws.ID)
		if e != nil {
			failed(w, 500, "Revocation failed", e)
			return
		}
		if tag.RowsAffected() == 0 {
			problem(w, 404, "Pending invitation not found")
			return
		}
		jsonOut(w, 200, map[string]bool{"ok": true})
		return
	}
	if r.Method != "POST" || id != "" {
		problem(w, 405, "Method not allowed")
		return
	}
	var in struct {
		Email   string `json:"email"`
		Role    string `json:"role"`
		Message string `json:"message"`
	}
	if !body(w, r, &in) {
		return
	}
	if utf8.RuneCountInString(in.Message) > 2000 {
		problem(w, 400, "Invitation message must be at most 2000 characters")
		return
	}
	email, e := normalizeEmail(in.Email)
	if e != nil {
		problem(w, 400, "Invalid email")
		return
	}
	if in.Role == "" {
		in.Role = "member"
	}
	if in.Role != "member" && in.Role != "viewer" {
		problem(w, 400, "Invalid role")
		return
	}
	if !s.rate(r.Context(), "invite:"+u.ID, 30) {
		problem(w, 429, "Too many invitations")
		return
	}
	inviteID := opaque()
	_, e = s.DB.Exec(r.Context(), "INSERT INTO invites(id,workspace_id,email,role,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')", inviteID, ws.ID, email, in.Role)
	if e != nil {
		failed(w, 500, "Invitation failed", e)
		return
	}
	if e = s.sendWorkspaceInvitation(email, ws.Name, in.Message); e != nil {
		s.DB.Exec(r.Context(), "UPDATE invites SET status='delivery-failed' WHERE id=$1", inviteID)
		failed(w, 503, "Invitation email delivery failed", e)
		return
	}
	jsonOut(w, 201, map[string]bool{"ok": true})
}

func (s *Service) sendWorkspaceInvitation(email, workspaceName, message string) error {
	text, markup, e := mailTemplate("invitation", map[string]string{"workspace": workspaceName, "publicURL": s.Config.PublicURL, "message": message})
	if e != nil {
		return e
	}
	return s.send(email, "Invitation Blok — "+workspaceName, text, markup)
}
