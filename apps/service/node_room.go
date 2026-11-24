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

func (s *Service) nodeOwnsRoom(doc string) bool {
	return doc != "" && s.Config.NodeRoomPage == doc
}

const nodeRoomAddress = "127.0.0.1:18102"

func (s *Service) recheckNodeRoom(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+nodeRoomAddress+"/internal/room/recheck-access", nil)
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
	if s.Config.NodeRoomPage == "" {
		return false
	}
	path := "/api/blok/sync/" + s.Config.NodeRoomPage
	if !s.nodeOwnsRoom(ticketDoc) {
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
