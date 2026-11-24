package cloud

import (
	"encoding/hex"
	"net/http"
	"time"

	"github.com/JackUait/blok/packages/server/go/v2/blokserver/ticket"

	"github.com/jackc/pgx/v5"
)

// Admission verifies the shell ticket before disclosing its session digest to
// the trusted room host. A connected room can recheck that session after the
// short-lived upgrade ticket expires. Each decision uses one DB snapshot.
func (s *Service) roomAccess(w http.ResponseWriter, r *http.Request) {
	if !internalAuth(r, s.Config.InternalSecret) {
		problem(w, http.StatusUnauthorized, "Internal authorization required")
		return
	}
	var input struct {
		Ticket     string `json:"ticket"`
		Session    string `json:"session"`
		DocumentID string `json:"documentId"`
	}
	if !body(w, r, &input) {
		return
	}
	if (input.Ticket == "") == (input.Session == "") || input.DocumentID == "" {
		problem(w, http.StatusBadRequest, "Specify a ticket or a session and one document")
		return
	}
	ticketWrite := false
	if input.Ticket != "" {
		claims, ok := ticket.Verify(s.Config.TicketSecret, input.Ticket, time.Now())
		if !ok || claims.Doc != input.DocumentID || claims.User == "" {
			problem(w, http.StatusUnauthorized, "Valid document ticket required")
			return
		}
		input.Session, ticketWrite = claims.User, claims.Write
	}
	_, err := hex.DecodeString(input.Session)
	if len(input.Session) != 64 || err != nil {
		problem(w, http.StatusBadRequest, "Invalid room authorization request")
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		problem(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	granted, err := s.documentSessionLevel(r.Context(), tx, input.Session, input.DocumentID)
	if err != nil || tx.Commit(r.Context()) != nil {
		problem(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	if input.Ticket != "" && granted >= levelView {
		jsonOut(w, http.StatusOK, map[string]any{"read": true, "write": granted >= levelEdit && ticketWrite, "session": input.Session, "ticketWrite": ticketWrite})
		return
	}
	jsonOut(w, http.StatusOK, map[string]bool{"read": granted >= levelView, "write": granted >= levelEdit})
}
