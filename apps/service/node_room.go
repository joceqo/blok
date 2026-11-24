package cloud

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
)

// Page IDs from the shell can be used as one literal URL path segment.
var roomPageID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

// The workspace selection stores a canonical ID. Querying the current page
// row on admission includes newly created pages without cache invalidation.
func (s *Service) nodeOwnsRoom(ctx context.Context, doc string) (bool, error) {
	if doc == "" {
		return false, nil
	}
	if s.Config.NodeRoomWorkspace == "" {
		return s.Config.NodeRoomPage == doc, nil
	}
	var selected bool
	err := s.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pages WHERE id=$1 AND workspace_id=$2)", doc, s.Config.NodeRoomWorkspace).Scan(&selected)
	return selected, err
}

// Multiroom verifies the ticket against the live Node ACL before opening a
// journal. Only the canonical upgrade path is forwarded before Go admission.
func (s *Service) routeWorkspaceUpgrade(proxy http.Handler, w http.ResponseWriter, r *http.Request) bool {
	if s.Config.NodeRoomWorkspace == "" || r.Method != "GET" || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	raw, ok := strings.CutPrefix(r.URL.EscapedPath(), "/api/blok/sync/")
	if !ok || raw == "" || strings.Contains(raw, "/") {
		return false
	}
	doc, err := url.PathUnescape(raw)
	if err != nil {
		problem(w, 400, "Invalid room path")
		return true
	}
	owned, err := s.nodeOwnsRoom(r.Context(), doc)
	if err != nil {
		problem(w, 503, "Room ownership unavailable")
		return true
	}
	if !owned {
		return false
	}
	forget := s.observeDocument(doc)
	defer forget()
	proxy.ServeHTTP(w, r)
	return true
}

const nodeRoomAddress = "127.0.0.1:18102"

func (s *Service) recheckNodeRoom(ctx context.Context, doc string) error {
	target := "http://" + nodeRoomAddress + "/internal/room/recheck-access"
	if s.Config.NodeRoomWorkspace != "" {
		target += "?documentId=" + url.QueryEscape(doc)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.Config.InternalSecret)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("Node room access recheck returned status %d", resp.StatusCode)
	}
	return nil
}

func nodeRoomProxy() *httputil.ReverseProxy {
	upstream := &url.URL{Scheme: "http", Host: nodeRoomAddress}
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.Header.Del("Cookie")
		},
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode == http.StatusSwitchingProtocols {
				response.Header.Set("X-Blok-Collaboration", "node")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			problem(w, http.StatusServiceUnavailable, "Node room unavailable")
		},
	}
}

// A stopped or unreachable Node room must never fall back to the Go writer.
func (s *Service) routeNodeRoom(proxy http.Handler, w http.ResponseWriter, r *http.Request, ticketDoc string) bool {
	if s.Config.NodeRoomWorkspace != "" {
		if !strings.HasPrefix(strings.ToLower(r.URL.Path), "/api/blok/sync/") {
			return false
		}
		owned, err := s.nodeOwnsRoom(r.Context(), ticketDoc)
		if err != nil {
			problem(w, 503, "Room ownership unavailable")
			return true
		}
		if owned {
			problem(w, 409, "This page uses the Node room")
			return true
		}
		return false
	}
	if s.Config.NodeRoomPage == "" {
		return false
	}
	path := "/api/blok/sync/" + s.Config.NodeRoomPage
	if ticketDoc != s.Config.NodeRoomPage {
		if r.URL.Path == path || strings.HasPrefix(r.URL.Path, path+"/") {
			problem(w, http.StatusForbidden, "Document access refused")
			return true
		}
		return false
	}
	if r.URL.Path == path && r.Method == "GET" && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		proxy.ServeHTTP(w, r)
		return true
	}
	if strings.HasPrefix(strings.ToLower(r.URL.Path), "/api/blok/sync/") {
		problem(w, http.StatusConflict, "This page uses the Node room")
		return true
	}
	return false
}
