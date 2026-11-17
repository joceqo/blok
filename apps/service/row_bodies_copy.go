package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"net/url"
)

// Duplication materializes bodies into the new document, so copies never share
// mutable body documents. This work occurs only on an explicit duplicate.
func (s *Service) inlineRowBodiesForCopy(ctx context.Context, u identity, workspaceID string, content map[string]any) ([]string, error) {
	seen := map[string]bool{}
	documents := []string{}
	var expand func(map[string]any, int) error
	expand = func(document map[string]any, depth int) error {
		if depth >= maxPageDepth {
			return errors.New("row body nesting exceeds limit")
		}
		blocks, _ := document["blocks"].([]any)
		ids := map[string]bool{}
		for _, raw := range blocks {
			if b, ok := raw.(map[string]any); ok {
				id, _ := b["id"].(string)
				ids[id] = true
			}
		}
		expanded := append([]any(nil), blocks...)
		for _, raw := range blocks {
			row, ok := raw.(map[string]any)
			if !ok || row["type"] != "database-row" {
				continue
			}
			data, _ := row["data"].(map[string]any)
			pageID, _ := data["pageId"].(string)
			if pageID == "" {
				continue
			}
			if seen[pageID] {
				return errors.New("cyclic or repeated row body")
			}
			seen[pageID] = true
			var exists bool
			if err := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pages WHERE id=$1 AND workspace_id=$2 AND NOT deleted AND NOT trashed)`, pageID, workspaceID).Scan(&exists); err != nil {
				return err
			}
			level, err := s.effectiveLevel(ctx, s.DB, u.ID, pageID)
			if err != nil {
				return err
			}
			if !exists || level < levelView {
				return errors.New("row body unavailable")
			}
			ticket, err := s.mintSessionTicket(u, pageID, true)
			if err != nil {
				return err
			}
			req := httptest.NewRequest("GET", "/api/blok/sync/"+url.PathEscape(pageID)+"/state?ticket="+url.QueryEscape(ticket), nil).WithContext(ctx)
			req.Header.Set("Origin", s.Config.PublicURL)
			req.Header.Set("Authorization", "Bearer "+ticket)
			response := httptest.NewRecorder()
			s.blokHandler(s.Blok.Handler("/api/blok")).ServeHTTP(response, req)
			if response.Code != 200 {
				return errors.New("could not snapshot row body")
			}
			var body map[string]any
			if err = json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				return err
			}
			if err = expand(body, depth+1); err != nil {
				return err
			}
			children := []string{}
			bodyBlocks, _ := body["blocks"].([]any)
			for _, rawChild := range bodyBlocks {
				child, ok := rawChild.(map[string]any)
				if !ok {
					return errors.New("invalid body block")
				}
				id, _ := child["id"].(string)
				if id == "" || ids[id] {
					return errors.New("conflicting body block identifiers")
				}
				ids[id] = true
				if parent, _ := child["parent"].(string); parent == "" {
					child["parent"] = row["id"]
					children = append(children, id)
				}
				expanded = append(expanded, child)
			}
			if existing, _ := row["content"].([]any); len(existing) > 0 {
				return errors.New("row has both inline and external content")
			}
			row["content"] = children
			delete(data, "pageId")
			data["bodyBlocks"] = true
			documents = append(documents, pageID)
		}
		document["blocks"] = expanded
		return nil
	}
	err := expand(content, 0)
	return documents, err
}
