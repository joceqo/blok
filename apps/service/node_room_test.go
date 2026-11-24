package cloud

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/JackUait/blok/packages/server/go/v2/blokserver"
)

func TestNodeRoomHasOneHost(t *testing.T) {
	s := &Service{Config: Config{NodeRoomPage: "one"}}
	origin := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(101) })
	for _, tc := range []struct {
		doc, method, path, upgrade string
		handled                    bool
		status                     int
	}{
		{"one", "GET", "/api/blok/sync/one", "websocket", true, 101},
		{"one", "POST", "/api/blok/sync/one/edit", "", true, 409},
		{"one", "GET", "/api/blok/sync/two", "websocket", true, 409},
		{"two", "GET", "/api/blok/sync/one", "websocket", true, 403},
		{"two", "GET", "/api/blok/sync/two", "websocket", false, 200},
		{"one", "POST", "/api/blok/upload", "", false, 200},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Upgrade", tc.upgrade)
		w := httptest.NewRecorder()
		if handled := s.routeNodeRoom(origin, w, r, tc.doc); handled != tc.handled || w.Code != tc.status {
			t.Errorf("%s %s as %s: handled=%v status=%d", tc.method, tc.path, tc.doc, handled, w.Code)
		}
	}
	// Also guard direct internal consumers of the embedded Go room factory.
	ctx := context.Background()
	for _, check := range []func(context.Context, blokserver.User, string) (bool, error){s.CanReadDocument, s.CanWriteDocument} {
		if allowed, err := check(ctx, blokserver.User{}, "one"); err != nil || allowed {
			t.Fatal(allowed, err)
		}
	}
	for _, write := range []bool{false, true} {
		if allowed, err := s.authorizeMCPDocument(ctx, "user", "one", write); err != nil || allowed {
			t.Fatal(allowed, err)
		}
	}
}

// Exercise the real reverse proxy, including the HTTP/1.1 protocol switch:
// a lost room must return a retryable error instead of opening the Go journal.
func TestNodeRoomProxyUpgradeAndOutage(t *testing.T) {
	const protocol = "blok-sync.v2"
	seen := make(chan *http.Request, 1)
	room := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		conn, buf, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, err = fmt.Fprintf(buf, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: %s\r\n\r\n", protocol)
		if err != nil {
			t.Error(err)
			return
		}
		if err := buf.Flush(); err != nil {
			t.Error(err)
		}
	}))
	defer room.Close()
	proxy := nodeRoomProxy()
	proxy.Transport = &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, room.Listener.Addr().String())
	}}
	host := httptest.NewServer(proxy)
	defer host.Close()
	upgrade := func() *http.Response {
		req, err := http.NewRequest(http.MethodGet, host.URL+"/api/blok/sync/one", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Connection", "Upgrade")
		req.Header.Set("Upgrade", "websocket")
		req.Header.Set("Origin", "tauri://localhost")
		req.Header.Set("Cookie", "blok_session=local-fixture")
		req.Header.Set("Sec-WebSocket-Protocol", protocol+", document-ticket")
		client := &http.Client{Timeout: 3 * time.Second}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	response := upgrade()
	response.Body.Close()
	if response.StatusCode != 101 || response.Header.Get("X-Blok-Collaboration") != "node" || response.Header.Get("Sec-WebSocket-Protocol") != protocol {
		t.Fatalf("unexpected upgrade %d %v", response.StatusCode, response.Header)
	}
	req := <-seen
	if req.URL.Path != "/api/blok/sync/one" || req.Header.Get("Cookie") != "" ||
		req.Header.Get("Origin") != "tauri://localhost" || req.Header.Get("Sec-WebSocket-Protocol") != protocol+", document-ticket" {
		t.Fatal("upstream path or credential boundary changed")
	}
	room.Close()
	response = upgrade()
	defer response.Body.Close()
	if response.StatusCode != 503 {
		t.Fatalf("offline room returned %d", response.StatusCode)
	}
}
