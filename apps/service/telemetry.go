package cloud

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Error reporting to a Sentry-compatible collector (GlitchTip).
//
// It wraps the logger rather than adding calls at each failure site: everything
// already logged at error level is reported, and nothing new has to be
// remembered at the next one. Switched on by ERROR_REPORTING_DSN alone, so
// turning it on is a redeploy, not a code change.
//
// Reporting must never affect serving. Sending happens off the request
// goroutine, is dropped when too many are already in flight, and never logs
// through slog itself — that would report the failure to report.

const (
	errorReportingConcurrency = 4
	errorReportingTimeout     = 5 * time.Second
)

// Attribute keys whose value never leaves this process. Matched as substrings:
// "token" also covers "access_token", "email" covers "user_email".
var errorReportingRedactedKeys = []string{
	"token", "secret", "key", "password", "passwd", "authorization", "cookie", "email", "dsn", "credential",
}

func errorReportingRedacts(key string) bool {
	lower := strings.ToLower(key)
	for _, needle := range errorReportingRedactedKeys {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

// parseErrorReportingDSN splits "https://<key>@<host>/<project>" into the ingest
// endpoint and the public key.
func parseErrorReportingDSN(dsn string) (string, string, error) {
	trimmed := strings.TrimSpace(dsn)
	if trimmed == "" {
		return "", "", errors.New("error reporting DSN is empty")
	}
	parsed, e := url.Parse(trimmed)
	if e != nil {
		return "", "", e
	}
	key := ""
	if parsed.User != nil {
		key = parsed.User.Username()
	}
	project := strings.Trim(parsed.Path, "/")
	if parsed.Host == "" || key == "" || project == "" {
		return "", "", errors.New("error reporting DSN must be https://<key>@<host>/<project>")
	}
	if _, e := strconv.Atoi(project); e != nil {
		return "", "", fmt.Errorf("error reporting DSN project %q is not a number", project)
	}
	return fmt.Sprintf("%s://%s/api/%s/envelope/", parsed.Scheme, parsed.Host, project), key, nil
}

type errorReportMessage struct {
	Formatted string `json:"formatted"`
}

type errorReport struct {
	EventID     string             `json:"event_id"`
	Timestamp   string             `json:"timestamp"`
	Platform    string             `json:"platform"`
	Level       string             `json:"level"`
	Logger      string             `json:"logger"`
	Environment string             `json:"environment"`
	ServerName  string             `json:"server_name"`
	Message     errorReportMessage `json:"message"`
	Extra       map[string]string  `json:"extra"`
	// Tags are what GlitchTip shows on the issue and filters on. Extra alone
	// does not come back out, so the fields worth searching live here too.
	Tags map[string]string `json:"tags"`
}

func errorReportingID() string {
	raw := make([]byte, 16)
	if _, e := rand.Read(raw); e != nil {
		return strings.Repeat("0", 32)
	}
	return hex.EncodeToString(raw)
}

func errorReportingEvent(record slog.Record, attrs []slog.Attr, environment, host string) errorReport {
	extra := map[string]string{}
	tags := map[string]string{}
	add := func(attr slog.Attr) {
		if attr.Key == "" || errorReportingRedacts(attr.Key) {
			return
		}
		value := attr.Value.String()
		extra[attr.Key] = value
		// Kept short: a tag is an index key, not a place for a payload.
		if len(value) <= 200 {
			tags[attr.Key] = value
		}
	}
	for _, attr := range attrs {
		add(attr)
	}
	record.Attrs(func(attr slog.Attr) bool {
		add(attr)
		return true
	})
	return errorReport{
		EventID:     errorReportingID(),
		Timestamp:   record.Time.UTC().Format(time.RFC3339Nano),
		Platform:    "go",
		Level:       strings.ToLower(record.Level.String()),
		Logger:      "blok-service",
		Environment: environment,
		ServerName:  host,
		Message:     errorReportMessage{Formatted: record.Message},
		Extra:       extra,
		Tags:        tags,
	}
}

func errorReportingEnvelope(event errorReport) ([]byte, error) {
	payload, e := json.Marshal(event)
	if e != nil {
		return nil, e
	}
	header, e := json.Marshal(map[string]string{"event_id": event.EventID, "sent_at": time.Now().UTC().Format(time.RFC3339Nano)})
	if e != nil {
		return nil, e
	}
	item, e := json.Marshal(map[string]any{"type": "event", "length": len(payload)})
	if e != nil {
		return nil, e
	}
	var envelope bytes.Buffer
	envelope.Write(header)
	envelope.WriteByte('\n')
	envelope.Write(item)
	envelope.WriteByte('\n')
	envelope.Write(payload)
	envelope.WriteByte('\n')
	return envelope.Bytes(), nil
}

type errorReportingHandler struct {
	next      slog.Handler
	attrs     []slog.Attr
	send      func(slog.Record, []slog.Attr)
	enabled   bool
	threshold slog.Level
}

func (h *errorReportingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *errorReportingHandler) Handle(ctx context.Context, record slog.Record) error {
	if record.Level >= h.threshold {
		h.send(record.Clone(), h.attrs)
	}
	return h.next.Handle(ctx, record)
}

func (h *errorReportingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &errorReportingHandler{next: h.next.WithAttrs(attrs), attrs: append(append([]slog.Attr{}, h.attrs...), attrs...), send: h.send, enabled: h.enabled, threshold: h.threshold}
}

func (h *errorReportingHandler) WithGroup(name string) slog.Handler {
	return &errorReportingHandler{next: h.next.WithGroup(name), attrs: h.attrs, send: h.send, enabled: h.enabled, threshold: h.threshold}
}

// newErrorReportingHandler wraps next so error lines are also reported.
//
// An empty or malformed DSN returns next itself: a mistyped setting must leave
// logging exactly as it was rather than half-installing a reporter.
// The returned function waits for reports already in flight.
// errorReportingLevel reads the reporting threshold. Anything unrecognised means
// error: a typo must not quietly flood the collector with ordinary traffic.
func errorReportingLevel(value string) slog.Level {
	if strings.EqualFold(strings.TrimSpace(value), "warn") {
		return slog.LevelWarn
	}
	return slog.LevelError
}

func newErrorReportingHandler(next slog.Handler, dsn, environment, host string, threshold slog.Level) (slog.Handler, func()) {
	endpoint, key, e := parseErrorReportingDSN(dsn)
	if e != nil {
		return next, func() {}
	}
	var waiting sync.WaitGroup
	slots := make(chan struct{}, errorReportingConcurrency)
	client := &http.Client{Timeout: errorReportingTimeout}
	send := func(record slog.Record, attrs []slog.Attr) {
		select {
		case slots <- struct{}{}:
		default:
			return // Already saturated: drop the report rather than hold up the caller.
		}
		waiting.Add(1)
		go func() {
			defer func() { <-slots; waiting.Done() }()
			envelope, e := errorReportingEnvelope(errorReportingEvent(record, attrs, environment, host))
			if e != nil {
				return
			}
			request, e := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(envelope))
			if e != nil {
				return
			}
			request.Header.Set("Content-Type", "application/x-sentry-envelope")
			request.Header.Set("X-Sentry-Auth", fmt.Sprintf("Sentry sentry_version=7, sentry_client=blok/1, sentry_key=%s", key))
			response, e := client.Do(request)
			if e != nil {
				return
			}
			_ = response.Body.Close()
		}()
	}
	return &errorReportingHandler{next: next, send: send, enabled: true, threshold: threshold}, waiting.Wait
}

// InstallErrorReporting routes error logs to the configured collector and
// returns a function that waits for the reports already in flight.
//
// Called before anything else builds a logger: the service passes
// slog.Default() down, so wrapping it here is what reaches every component.
func InstallErrorReporting(c Config) func() {
	environment := "production"
	if c.Development {
		environment = "development"
	}
	host, _ := os.Hostname()
	handler, flush := newErrorReportingHandler(slog.Default().Handler(), c.ErrorReportingDSN, environment, host, errorReportingLevel(c.ErrorReportingLevel))
	slog.SetDefault(slog.New(handler))
	return flush
}

// recordedResponse remembers the status so the middleware can judge it.
//
// It forwards Flusher and Hijacker deliberately: collaboration upgrades the
// connection, and a wrapper that hid Hijacker would break the sync socket
// instead of merely losing a log line.
type recordedResponse struct {
	http.ResponseWriter
	status int
}

func (r *recordedResponse) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recordedResponse) Write(p []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(p)
}

func (r *recordedResponse) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (r *recordedResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("connection cannot be hijacked")
	}
	return hijacker.Hijack()
}

// logFailedResponses journals every response the server refuses.
//
// Wrapped around the whole handler rather than added to `problem`, so it also
// covers refusals written directly and carries the method and path that
// `problem` never receives. 5xx is ours to fix, hence error level; 4xx is the
// caller's and stays a warning — 401 and 404 are ordinary traffic and would
// drown anything worth seeing.
func logFailedResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorded := &recordedResponse{ResponseWriter: w}
		next.ServeHTTP(recorded, r)
		if recorded.status < 400 {
			return
		}
		level := slog.LevelWarn
		if recorded.status >= 500 {
			level = slog.LevelError
		}
		slog.Log(r.Context(), level, "request refused",
			"status", recorded.status, "method", r.Method, "path", r.URL.Path)
	})
}
