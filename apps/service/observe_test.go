package cloud

import (
	"bufio"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A handler that hijacks, as the collaboration upgrade does. The wrapper must
// hand the connection over or every WebSocket in production stops upgrading.
type hijackable struct {
	http.ResponseWriter
	taken bool
}

func (h *hijackable) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.taken = true

	return nil, nil, nil
}

// lines decodes what the logger wrote, one JSON object per line.
func lines(t *testing.T, written string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(written), "\n") {
		if raw == "" {
			continue
		}
		var one map[string]any
		if e := json.Unmarshal([]byte(raw), &one); e != nil {
			t.Fatalf("log line is not JSON: %q (%v)", raw, e)
		}
		out = append(out, one)
	}

	return out
}

// A refusal is the moment worth keeping: it carries the reason the handler
// chose, which is the one thing a status code cannot tell anybody.
func TestObserveRecordsARefusalWithItsReason(t *testing.T) {
	log, written := testLogger()
	handler := observe(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		problem(w, 422, "Document already has a block \"b1\"")
	}), log, time.Now)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/pages/p1/edit", nil))

	got := lines(t, written.String())
	if len(got) != 1 {
		t.Fatalf("logged %d lines, want exactly one", len(got))
	}
	for key, want := range map[string]any{
		"msg": "request refused", "method": "POST",
		"path": "/api/pages/p1/edit", "status": float64(422),
	} {
		if got[0][key] != want {
			t.Errorf("%s = %v, want %v", key, got[0][key], want)
		}
	}
	if cause, _ := got[0]["cause"].(string); !strings.Contains(cause, "already has a block") {
		t.Errorf("cause = %q, want the reason problem() wrote", cause)
	}
	if id, _ := got[0]["request"].(string); len(id) != 32 {
		t.Errorf("request = %q, want 32 hex characters", id)
	}
	if _, ok := got[0]["ms"]; !ok {
		t.Error("no ms: a refusal that took a long time is a different problem from a quick one")
	}
}

// Every answered request would be a log line per page view, written to the SD
// card this runs from. Metrics count them; the journal keeps what went wrong.
func TestObserveKeepsQuietOnAnAnsweredRequest(t *testing.T) {
	log, written := testLogger()
	handler := observe(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		jsonOut(w, 200, map[string]any{"ok": true})
	}), log, time.Now)

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/instance", nil))

	if out := strings.TrimSpace(written.String()); out != "" {
		t.Fatalf("logged %q, want nothing", out)
	}
}

// A request nobody refused but that took seconds is the other half of what a
// status code hides.
func TestObserveRecordsAnAnsweredRequestThatTookTooLong(t *testing.T) {
	log, written := testLogger()
	clock := stoppedClock(slowRequest + time.Millisecond)
	handler := observe(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		jsonOut(w, 200, map[string]any{"ok": true})
	}), log, clock)

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/instance", nil))

	got := lines(t, written.String())
	if len(got) != 1 || got[0]["msg"] != "request slow" {
		t.Fatalf("logged %v, want one \"request slow\" line", got)
	}
	if got[0]["status"] != float64(200) {
		t.Errorf("status = %v, want 200", got[0]["status"])
	}
}

// The collaboration socket upgrades by hijacking. A wrapper that does not pass
// that through breaks every live document, and no test of status codes notices.
func TestObserveHandsOverAHijackedConnection(t *testing.T) {
	log, _ := testLogger()
	under := &hijackable{ResponseWriter: httptest.NewRecorder()}
	handler := observe(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		taker, ok := w.(http.Hijacker)
		if !ok {
			t.Error("the wrapped writer is not a Hijacker: WebSocket upgrades would fail")

			return
		}
		if _, _, e := taker.Hijack(); e != nil {
			t.Errorf("Hijack: %v", e)
		}
	}), log, time.Now)

	handler.ServeHTTP(under, httptest.NewRequest("GET", "/api/blok/sync/d", nil))

	if !under.taken {
		t.Fatal("the connection was never handed over")
	}
}

// A refusal body is bounded: a handler that streams must not put its stream in
// the journal.
func TestObserveBoundsTheReasonItKeeps(t *testing.T) {
	log, written := testLogger()
	handler := observe(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(strings.Repeat("x", causeLimit*4)))
	}), log, time.Now)

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/instance", nil))

	got := lines(t, written.String())
	if len(got) != 1 {
		t.Fatalf("logged %d lines, want one", len(got))
	}
	if cause, _ := got[0]["cause"].(string); len(cause) > causeLimit {
		t.Errorf("cause is %d bytes, want at most %d", len(cause), causeLimit)
	}
}
