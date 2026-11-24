package cloud

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

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
