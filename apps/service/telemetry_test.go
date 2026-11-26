package cloud

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestErrorReportingDSN(t *testing.T) {
	endpoint, key, e := parseErrorReportingDSN("https://abc123@glitchtip.example.com/7")
	if e != nil {
		t.Fatalf("parse: %v", e)
	}
	if endpoint != "https://glitchtip.example.com/api/7/envelope/" {
		t.Fatalf("endpoint = %q", endpoint)
	}
	if key != "abc123" {
		t.Fatalf("key = %q", key)
	}
	for _, bad := range []string{"", "not a url", "https://glitchtip.example.com/7", "https://abc@host/", "https://abc@host/notanumber"} {
		if _, _, e := parseErrorReportingDSN(bad); e == nil {
			t.Fatalf("expected %q to be refused", bad)
		}
	}
}

// Reporting must never widen what a log line already exposes.
func TestErrorReportingRedactsSensitiveAttributes(t *testing.T) {
	event := errorReportingEvent(slog.Record{Message: "boom", Level: slog.LevelError, Time: time.Unix(0, 0).UTC()},
		[]slog.Attr{slog.String("document", "doc-1"), slog.String("token", "s3cr3t"),
			slog.String("Authorization", "Bearer x"), slog.String("user_email", "a@b.c")}, "production", "host-1")
	extra, _ := json.Marshal(event.Extra)
	if strings.Contains(string(extra), "s3cr3t") || strings.Contains(string(extra), "Bearer") || strings.Contains(string(extra), "a@b.c") {
		t.Fatalf("secret leaked into %s", extra)
	}
	if !strings.Contains(string(extra), "doc-1") {
		t.Fatalf("harmless attribute dropped from %s", extra)
	}
	if event.Level != "error" || event.Message.Formatted != "boom" {
		t.Fatalf("event = %+v", event)
	}
}

func TestErrorReportingSendsOnlyErrorsAndAlwaysPassesThrough(t *testing.T) {
	var mu sync.Mutex
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(body)
		mu.Lock()
		bodies = append(bodies, string(body))
		mu.Unlock()
		if !strings.Contains(r.Header.Get("X-Sentry-Auth"), "sentry_key=abc123") {
			t.Errorf("missing auth header: %q", r.Header.Get("X-Sentry-Auth"))
		}
		w.WriteHeader(200)
	}))
	defer server.Close()

	var kept []string
	next := slog.NewTextHandler(writerFunc(func(p []byte) (int, error) { kept = append(kept, string(p)); return len(p), nil }), nil)
	// The DSN carries the key and project: http://<key>@<host>/<project>
	dsn := strings.Replace(server.URL, "://", "://abc123@", 1) + "/9"
	handler, flush := newErrorReportingHandler(next, dsn, "production", "host-1", slog.LevelError)
	logger := slog.New(handler)

	logger.Info("ordinary line")
	logger.Error("real failure", "document", "doc-1")
	flush()

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("expected exactly one report, got %d", len(bodies))
	}
	if !strings.Contains(bodies[0], "real failure") || strings.Contains(bodies[0], "ordinary line") {
		t.Fatalf("wrong payload: %s", bodies[0])
	}
	// The envelope is three newline-delimited JSON documents.
	if lines := strings.Split(strings.TrimRight(bodies[0], "\n"), "\n"); len(lines) != 3 {
		t.Fatalf("envelope has %d lines: %s", len(lines), bodies[0])
	}
	if len(kept) != 2 {
		t.Fatalf("underlying handler saw %d lines, want 2", len(kept))
	}
}

func TestErrorReportingDisabledWithoutDSN(t *testing.T) {
	next := slog.NewTextHandler(writerFunc(func(p []byte) (int, error) { return len(p), nil }), nil)
	handler, flush := newErrorReportingHandler(next, "", "production", "host-1", slog.LevelError)
	if handler != next {
		t.Fatal("an empty DSN must leave logging exactly as it was")
	}
	flush()
	if handler.Enabled(context.Background(), slog.LevelError) != next.Enabled(context.Background(), slog.LevelError) {
		t.Fatal("enablement changed")
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func TestInstallErrorReportingReadsTheEnvironment(t *testing.T) {
	previous := slog.Default()
	defer slog.SetDefault(previous)

	t.Setenv("ERROR_REPORTING_DSN", "https://abc123@glitchtip.example.com/7")
	if ConfigFromEnv().ErrorReportingDSN != "https://abc123@glitchtip.example.com/7" {
		t.Fatal("the DSN must come from the environment, so enabling it is a redeploy")
	}
	flush := InstallErrorReporting(ConfigFromEnv())
	defer flush()
	if slog.Default() == previous {
		t.Fatal("the default logger was not wrapped, so nothing would ever be reported")
	}

	t.Setenv("ERROR_REPORTING_DSN", "")
	slog.SetDefault(previous)
	InstallErrorReporting(ConfigFromEnv())
	if slog.Default().Handler() != previous.Handler() {
		t.Fatal("without a DSN the logger must be left exactly as it was")
	}
}

func TestFailedResponsesAreLogged(t *testing.T) {
	var lines []string
	previous := slog.Default()
	defer slog.SetDefault(previous)
	slog.SetDefault(slog.New(slog.NewTextHandler(
		writerFunc(func(p []byte) (int, error) { lines = append(lines, string(p)); return len(p), nil }),
		&slog.HandlerOptions{Level: slog.LevelDebug})))

	handler := logFailedResponses(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/boom":
			problem(w, 500, "Seeding failed")
		case "/conflict":
			problem(w, 409, "Document already initialized or collaboration started")
		default:
			w.WriteHeader(200)
		}
	}))

	for _, path := range []string{"/ok", "/conflict", "/boom"} {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, path, nil))
	}

	joined := strings.Join(lines, "")
	if strings.Contains(joined, "/ok") {
		t.Fatalf("a successful response must stay silent: %s", joined)
	}
	if !strings.Contains(joined, "level=WARN") || !strings.Contains(joined, "/conflict") {
		t.Fatalf("a 4xx must be logged as a warning: %s", joined)
	}
	if !strings.Contains(joined, "level=ERROR") || !strings.Contains(joined, "/boom") {
		t.Fatalf("a 5xx must be logged as an error: %s", joined)
	}
	if !strings.Contains(joined, "POST") {
		t.Fatalf("the method belongs in the line: %s", joined)
	}
}

// Collaboration upgrades the connection. A wrapper that drops Hijacker or
// Flusher would break the sync socket, not just the logging.
func TestLoggingKeepsConnectionUpgradesPossible(t *testing.T) {
	var hijackable, flushable bool
	handler := logFailedResponses(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hijackable = w.(http.Hijacker)
		_, flushable = w.(http.Flusher)
		w.WriteHeader(200)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/blok/sync/doc", nil))
	if !hijackable || !flushable {
		t.Fatalf("hijackable=%v flushable=%v — the sync socket needs both", hijackable, flushable)
	}
}

// A 4xx is a warning, so the 409 worth chasing is invisible at the default
// threshold. Lowering it must be a setting, not an edit.
func TestErrorReportingThresholdCanIncludeWarnings(t *testing.T) {
	if errorReportingLevel("warn") != slog.LevelWarn || errorReportingLevel("") != slog.LevelError {
		t.Fatal("threshold parsing")
	}
	var mu sync.Mutex
	count := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		count++
		mu.Unlock()
		w.WriteHeader(200)
	}))
	defer server.Close()
	next := slog.NewTextHandler(writerFunc(func(p []byte) (int, error) { return len(p), nil }), &slog.HandlerOptions{Level: slog.LevelDebug})
	dsn := strings.Replace(server.URL, "://", "://abc123@", 1) + "/9"
	handler, flush := newErrorReportingHandler(next, dsn, "production", "host-1", slog.LevelWarn)
	logger := slog.New(handler)
	logger.Info("ignored")
	logger.Warn("request refused", "status", 409)
	flush()
	mu.Lock()
	defer mu.Unlock()
	if count != 1 {
		t.Fatalf("expected the warning to be reported, got %d reports", count)
	}
}

// GlitchTip surfaces tags in the issue view and lets you filter on them; the
// first live event proved "extra" alone does not come back. Status, method and
// path are the whole point of the report, so they travel as tags too.
func TestErrorReportingPutsAttributesInTags(t *testing.T) {
	record := slog.Record{Message: "request refused", Level: slog.LevelError, Time: time.Unix(0, 0).UTC()}
	record.Add("status", 409, "method", "POST", "path", "/api/workspaces/nexenture/pages/x/seed", "token", "s3cr3t")
	event := errorReportingEvent(record, nil, "production", "host-1")
	if event.Tags["status"] != "409" || event.Tags["method"] != "POST" {
		t.Fatalf("tags = %v", event.Tags)
	}
	if event.Tags["path"] != "/api/workspaces/nexenture/pages/x/seed" {
		t.Fatalf("path missing from tags: %v", event.Tags)
	}
	if _, leaked := event.Tags["token"]; leaked {
		t.Fatalf("redaction must apply to tags as well: %v", event.Tags)
	}
	if event.Extra["status"] != "409" {
		t.Fatalf("extra should still carry everything: %v", event.Extra)
	}
}

// Wrapping slog's default handler deadlocks the process on its first log line.
//
// slog.SetDefault redirects the standard log package into slog, and slog's
// default handler writes THROUGH that same log package. Wrapping it closes the
// loop on log.Logger's non-reentrant mutex: the first line blocks forever, the
// server never reaches ListenAndServe, and nothing is ever printed to say so.
// This shipped and took down a deployment.
func TestInstallErrorReportingDoesNotDeadlockTheDefaultLogger(t *testing.T) {
	previous := slog.Default()
	defer slog.SetDefault(previous)

	for _, dsn := range []string{"", "https://abc123@glitchtip.example.com/7"} {
		t.Setenv("ERROR_REPORTING_DSN", dsn)
		slog.SetDefault(previous)
		flush := InstallErrorReporting(ConfigFromEnv())
		logged := make(chan struct{})
		go func() {
			slog.Info("service listening", "address", ":8080")
			close(logged)
		}()
		select {
		case <-logged:
		case <-time.After(5 * time.Second):
			t.Fatalf("logging deadlocked with DSN %q", dsn)
		}
		flush()
	}
}

// Sentry's vocabulary is fatal/error/warning/info/debug. slog says "WARN", which
// GlitchTip does not recognise and silently promotes to error — every 404 then
// looks like a fault.
func TestErrorReportingUsesSentryLevelNames(t *testing.T) {
	for level, want := range map[slog.Level]string{
		slog.LevelError: "error", slog.LevelWarn: "warning",
		slog.LevelInfo: "info", slog.LevelDebug: "debug",
	} {
		event := errorReportingEvent(slog.Record{Message: "m", Level: level, Time: time.Unix(0, 0).UTC()}, nil, "production", "host")
		if event.Level != want {
			t.Fatalf("%s reported as %q, want %q", level, event.Level, want)
		}
	}
}

// One title for every refusal piles 4xx and 5xx into a single issue: 339 events
// deep, with no way to find the 500 among the 401s. The status belongs in the
// message so the collector groups by it. The path does not — one issue per
// document id would be useless noise.
func TestFailedResponsesGroupByStatus(t *testing.T) {
	var lines []string
	previous := slog.Default()
	defer slog.SetDefault(previous)
	slog.SetDefault(slog.New(slog.NewTextHandler(
		writerFunc(func(p []byte) (int, error) { lines = append(lines, string(p)); return len(p), nil }),
		&slog.HandlerOptions{Level: slog.LevelDebug})))

	handler := logFailedResponses(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		problem(w, 500, "Seeding failed")
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspaces/x/pages/y/seed", nil))

	joined := strings.Join(lines, "")
	id := response.Result().Header.Get("X-Request-ID")
	if len(id) != 32 || !strings.Contains(joined, "request_id="+id) {
		t.Fatal("the browser must be able to identify the refusal in the service log")
	}
	if !strings.Contains(joined, `msg="request refused with 500"`) {
		t.Fatalf("the status must be in the message, not only in a tag: %s", joined)
	}
	if strings.Contains(joined, `msg="request refused with 500 /api`) {
		t.Fatalf("the path must stay out of the message: %s", joined)
	}
}

// A wrapper that hides Unwrap breaks http.NewResponseController for everything
// it does not reimplement — SetReadDeadline, EnableFullDuplex. The sync socket
// reaches for those.
func TestRecordedResponseCanBeUnwrapped(t *testing.T) {
	recorder := httptest.NewRecorder()
	recorded := &recordedResponse{ResponseWriter: recorder}
	unwrapper, ok := interface{}(recorded).(interface{ Unwrap() http.ResponseWriter })
	if !ok {
		t.Fatal("recordedResponse must expose Unwrap")
	}
	if unwrapper.Unwrap() != http.ResponseWriter(recorder) {
		t.Fatal("Unwrap must return the writer underneath")
	}
}

// The status alone does not say which page carried the dead parentId. The
// refusal body does, and without it the collector shows a 400 with nothing to
// act on — the detail only ever reached the browser's network tab.
func TestFailedResponsesCarryTheRefusalDetail(t *testing.T) {
	var lines []string
	previous := slog.Default()
	defer slog.SetDefault(previous)
	slog.SetDefault(slog.New(slog.NewTextHandler(
		writerFunc(func(p []byte) (int, error) { lines = append(lines, string(p)); return len(p), nil }),
		&slog.HandlerOptions{Level: slog.LevelDebug})))

	handler := logFailedResponses(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		problem(w, 400, `Invalid parent hierarchy: page "p1" names parent "ghost", which does not exist`)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPut, "/api/workspaces/equipe/index", nil))

	joined := strings.Join(lines, "")
	if !strings.Contains(joined, "ghost") || !strings.Contains(joined, `page \"p1\"`) && !strings.Contains(joined, "p1") {
		t.Fatalf("the refusal detail must reach the log: %s", joined)
	}
}

// A successful response body must never be copied anywhere.
func TestSuccessfulResponsesAreNotCaptured(t *testing.T) {
	recorded := &recordedResponse{ResponseWriter: httptest.NewRecorder()}
	recorded.WriteHeader(200)
	_, _ = recorded.Write([]byte(`{"secret":"document content"}`))
	if recorded.detail.Len() != 0 {
		t.Fatalf("captured %q from a successful response", recorded.detail.String())
	}
}
