package cloud

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A handler that hijacks, as the collaboration upgrade does. The wrapper must
// hand the connection over or every WebSocket in production stops upgrading.
type hijackable struct {
	http.ResponseWriter
	taken bool
	wrote int
}

func (h *hijackable) WriteHeader(status int) {
	h.wrote++
	h.ResponseWriter.WriteHeader(status)
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

// The error a handler is holding is the only thing that says what broke. It
// belongs in the journal — and nowhere near the client, who gets the message
// the handler chose and nothing about this server's insides.
func TestFailedAnswersLikeProblemAndTellsTheClientNothingMore(t *testing.T) {
	captureDefaultLog(t)
	response := httptest.NewRecorder()

	failed(response, 500, "Could not list users", errors.New("connection refused"))

	if response.Code != 500 {
		t.Errorf("status = %d, want 500", response.Code)
	}
	var answer map[string]any
	if e := json.Unmarshal(response.Body.Bytes(), &answer); e != nil {
		t.Fatalf("body is not JSON: %q", response.Body.String())
	}
	if answer["error"] != "Could not list users" {
		t.Errorf("error = %v, want the message problem() would have written", answer["error"])
	}
	if strings.Contains(response.Body.String(), "connection refused") {
		t.Error("the Postgres error reached the client; it belongs in the journal")
	}
}

// Ninety handlers decide a 500. A line that carries the message alone cannot
// say which of them wrote it, nor what the database actually answered.
func TestFailedKeepsTheErrorAndWhereItHappened(t *testing.T) {
	written := captureDefaultLog(t)

	_, _, line, _ := runtime.Caller(0)
	failed(httptest.NewRecorder(), 500, "Could not list users", errors.New("connection refused"))

	got := lines(t, written.String())
	if len(got) != 1 {
		t.Fatalf("logged %d lines, want exactly one", len(got))
	}
	for key, want := range map[string]any{
		"level": "ERROR",
		"msg":   "Could not list users",
		"error": "connection refused",
		"at":    fmt.Sprintf("observe_test.go:%d", line+1),
	} {
		if got[0][key] != want {
			t.Errorf("%s = %v, want %v", key, got[0][key], want)
		}
	}
}

// "Read failed" is written from eight places. Without the call site their
// lines are indistinguishable, and the journal names a shape, not a place.
func TestFailedTellsTwoCallSitesApart(t *testing.T) {
	written := captureDefaultLog(t)

	failed(httptest.NewRecorder(), 500, "Read failed", errors.New("one"))
	failed(httptest.NewRecorder(), 500, "Read failed", errors.New("two"))

	got := lines(t, written.String())
	if len(got) != 2 {
		t.Fatalf("logged %d lines, want two", len(got))
	}
	if got[0]["at"] == got[1]["at"] {
		t.Errorf("both lines say %v; two call sites must not look like one", got[0]["at"])
	}
}

// observe names every request, and the failure is recorded in its own line.
// Without the name the two cannot be put back together: one says what broke,
// the other which path and how long it took.
func TestFailedCarriesTheNameOfItsRequest(t *testing.T) {
	written := captureDefaultLog(t)
	quiet := slog.New(slog.NewJSONHandler(io.Discard, nil))
	handler := observe(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		failed(w, 500, "Read failed", errors.New("connection refused"))
	}), quiet, time.Now)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/pages", nil))

	got := lines(t, written.String())
	if len(got) != 1 {
		t.Fatalf("logged %d lines, want exactly one", len(got))
	}
	if id := response.Header().Get("X-Request-Id"); got[0]["request"] != id {
		t.Errorf("request = %v, want %q", got[0]["request"], id)
	}
}

// Some failures have no error to show: a write that touched the wrong number
// of rows is a defect whose cause is the row count. Dropping the line because
// the cause is nil would hide exactly those.
func TestFailedLogsEvenWhenThereIsNoErrorToShow(t *testing.T) {
	written := captureDefaultLog(t)
	response := httptest.NewRecorder()

	failed(response, 500, "Could not register private upload", nil)

	if response.Code != 500 {
		t.Errorf("status = %d, want 500", response.Code)
	}
	got := lines(t, written.String())
	if len(got) != 1 {
		t.Fatalf("logged %d lines, want exactly one", len(got))
	}
	if at, _ := got[0]["at"].(string); !strings.HasPrefix(at, "observe_test.go:") {
		t.Errorf("at = %q, want this file", at)
	}
}

// A panic closes the connection and writes nothing: the client sees a cut
// line and the host keeps no trace. The stack is the whole point — without
// it the journal names a goroutine, not the defect.
func TestObserveAnswersAfterAPanicAndKeepsTheStack(t *testing.T) {
	log, written := testLogger()
	handler := observe(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		var pages map[string]string
		pages["p1"] = "boom"
	}), log, time.Now)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/pages", nil))

	if response.Code != 500 {
		t.Errorf("status = %d, want 500", response.Code)
	}
	got := lines(t, written.String())
	if len(got) != 1 {
		t.Fatalf("logged %d lines, want exactly one: %v", len(got), got)
	}
	if got[0]["msg"] != "handler panicked" {
		t.Errorf("msg = %v, want \"handler panicked\"", got[0]["msg"])
	}
	if cause, _ := got[0]["panic"].(string); !strings.Contains(cause, "nil map") {
		t.Errorf("panic = %q, want what the runtime said", cause)
	}
	if stack, _ := got[0]["stack"].(string); !strings.Contains(stack, "TestObserveAnswersAfterAPanicAndKeepsTheStack") {
		t.Errorf("stack = %q, want the frames that panicked", stack)
	}
	if got[0]["path"] != "/api/pages" {
		t.Errorf("path = %v, want the request that caused it", got[0]["path"])
	}
}

// A handler that upgraded to WebSocket owns the socket afterwards. Writing a
// status onto it puts HTTP in the middle of a framed session; the recovery
// would corrupt the very connection it meant to save.
func TestObserveWritesNoStatusOntoAHijackedConnection(t *testing.T) {
	log, written := testLogger()
	under := &hijackable{ResponseWriter: httptest.NewRecorder()}
	handler := observe(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, _, e := w.(http.Hijacker).Hijack(); e != nil {
			t.Errorf("Hijack: %v", e)
		}
		panic("the session died mid-frame")
	}), log, time.Now)

	handler.ServeHTTP(under, httptest.NewRequest("GET", "/api/blok/sync/d", nil))

	if under.wrote != 0 {
		t.Errorf("wrote a status %d time(s) onto a connection the handler owns", under.wrote)
	}
	got := lines(t, written.String())
	if len(got) != 1 || got[0]["msg"] != "handler panicked" {
		t.Fatalf("logged %v, want the panic kept anyway", got)
	}
}

// ErrAbortHandler is a handler hanging up on purpose, not a defect. Catching
// it would turn an intended silence into a 500 and an error in the journal.
func TestObserveLeavesADeliberateAbortToTheServer(t *testing.T) {
	log, written := testLogger()
	handler := observe(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}), log, time.Now)

	defer func() {
		if cause := recover(); cause != http.ErrAbortHandler {
			t.Errorf("recovered %v, want the abort to reach net/http", cause)
		}
		if out := strings.TrimSpace(written.String()); out != "" {
			t.Errorf("logged %q for a deliberate hang-up, want nothing", out)
		}
	}()
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/blok/sync/d", nil))
	t.Error("the abort was swallowed")
}
