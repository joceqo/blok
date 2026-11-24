package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

// Installed only for in-process requests built by addPageComment.
type commentDocumentKey struct{}

func (s *Service) addPageComment(w http.ResponseWriter, r *http.Request, u identity) {
	doc := r.PathValue("id")
	allowed, err := s.authorizePageLevel(r.Context(), u.ID, doc, levelComment)
	if err != nil {
		problem(w, 503, "Could not check comment access")
		return
	}
	if !allowed {
		visible, err := s.authorizePageLevel(r.Context(), u.ID, doc, levelView)
		if err != nil {
			problem(w, 503, "Could not check comment access")
			return
		}
		if !visible {
			problem(w, 404, "Page not found")
			return
		}
		problem(w, 403, "Comment access required")
		return
	}
	var in struct{ RequestID, Text, ThreadID string }
	if !body(w, r, &in) {
		return
	}
	in.Text = strings.TrimSpace(in.Text)
	if !pageIDPattern.MatchString(in.RequestID) || in.Text == "" || len(in.Text) > 16000 {
		problem(w, 400, "A request ID and a comment of at most 16000 bytes are required")
		return
	}
	sum := sha256.Sum256([]byte("comment\x00" + u.ID + "\x00" + doc + "\x00" + in.RequestID))
	id := hex.EncodeToString(sum[:16])
	ctx := context.WithValue(r.Context(), commentDocumentKey{}, doc)
	created := time.Now().UnixMilli()
	for attempt := 0; attempt < 3; attempt++ {
		state, err := s.placementState(ctx, u, doc)
		if err != nil {
			problem(w, placementStatus(err), "Discussion unavailable")
			return
		}
		if existing, ok := findPlacementBlock(state, id); ok {
			if existing.Type != "database-comment" || existing.Parent != in.ThreadID || existing.Data["text"] != in.Text || existing.Data["authorId"] != u.ID {
				problem(w, 409, "This request ID already belongs to another comment")
				return
			}
			jsonOut(w, 200, map[string]string{"commentId": id})
			return
		}
		var parent, after any
		if in.ThreadID != "" {
			thread, ok := findPlacementBlock(state, in.ThreadID)
			if !ok || thread.Type != "database-comment" || thread.Parent != "" || thread.Data["resolved"] == true || thread.Data["anchor"] != nil {
				problem(w, 409, "Page discussion is no longer open")
				return
			}
			parent = in.ThreadID
		}
		for _, b := range state.Blocks {
			if b.Parent == in.ThreadID {
				after = b.ID
			}
		}
		data := map[string]any{"text": in.Text, "createdAt": created, "authorId": u.ID}
		if u.Name != "" {
			data["authorName"] = u.Name
		}
		block := map[string]any{"id": id, "type": "database-comment", "data": data}
		op := map[string]any{"op": "insert", "id": id, "parent": parent, "after": after, "block": block}
		result, err := s.placementHTTP(ctx, u, doc, "POST", "edit", state.Head, id, map[string]any{"ops": []any{op}})
		if err != nil {
			problem(w, 503, "Could not save comment")
			return
		}
		if result.Code == http.StatusPreconditionFailed {
			continue
		}
		if result.Code != http.StatusNoContent {
			problem(w, result.Code, "Comment was not saved")
			return
		}
		jsonOut(w, 201, map[string]string{"commentId": id})
		return
	}
	problem(w, 409, "Discussion changed; retry the same comment")
}
