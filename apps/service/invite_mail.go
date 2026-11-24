package cloud

import (
	"errors"
	"net/http"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

func (s *Service) validateInvitationAddress(w http.ResponseWriter, r *http.Request) {
	if !internalAuth(r, s.Config.InternalSecret) {
		problem(w, 401, "Internal authorization required")
		return
	}
	var in struct {
		Email string `json:"email"`
	}
	if !body(w, r, &in) {
		return
	}
	email, err := normalizeEmail(in.Email)
	if err != nil {
		problem(w, 400, "Invalid email")
		return
	}
	jsonOut(w, 200, map[string]string{"email": email})
}

func (s *Service) deliverStagedInvitation(w http.ResponseWriter, r *http.Request) {
	if !internalAuth(r, s.Config.InternalSecret) {
		problem(w, 401, "Internal authorization required")
		return
	}
	var in struct {
		Message string `json:"message"`
	}
	if !body(w, r, &in) {
		return
	}
	if utf8.RuneCountInString(in.Message) > 2000 {
		problem(w, 400, "Invitation message must be at most 2000 characters")
		return
	}
	var email, name string
	err := s.DB.QueryRow(r.Context(), `SELECT i.email,w.name FROM invites i JOIN workspaces w ON w.id=i.workspace_id
		WHERE i.id=$1 AND i.status='delivering' AND i.expires_at>now()`, r.PathValue("id")).Scan(&email, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, 404, "Deliverable invitation not found")
		return
	}
	if err != nil {
		problem(w, 503, "Database unavailable")
		return
	}
	if err = s.sendWorkspaceInvitation(email, name, in.Message); err != nil {
		problem(w, 503, "Invitation email delivery failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
