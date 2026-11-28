package cloud

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"
)

// causeLimit bounds what a refusal contributes to one log line. The message
// problem() writes is short; a handler that streams must not put its stream in
// the journal, and this host writes its journal to an SD card.
const causeLimit = 256

// slowRequest is where an answered request becomes worth keeping on its own.
// Below it the request is ordinary and only the counters care.
const slowRequest = 2 * time.Second

/*
watched remembers what a handler decided, so the line written after it can say
more than "it happened".

It records the status and the opening bytes of a refusal body — which is where
problem() puts its reason, and the one thing a status code cannot carry.

It forwards Hijack and Flush. Without Hijack the collaboration upgrade stops
working and nothing about status codes notices; without Flush a streamed answer
is held until the handler returns.
*/
type watched struct {
	http.ResponseWriter
	status   int
	cause    []byte
	written  bool
	hijacked bool
}

func (w *watched) WriteHeader(status int) {
	if w.written {
		return
	}
	w.status = status
	w.written = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *watched) Write(b []byte) (int, error) {
	if !w.written {
		// net/http infers 200 from the first write; the wrapper has to infer it
		// too, or an answered request looks like it chose no status at all.
		w.status = http.StatusOK
		w.written = true
	}
	if w.status >= http.StatusBadRequest && len(w.cause) < causeLimit {
		w.cause = append(w.cause, b[:min(len(b), causeLimit-len(w.cause))]...)
	}

	return w.ResponseWriter.Write(b)
}

func (w *watched) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	taker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	conn, buffered, e := taker.Hijack()
	if e == nil {
		// From here the handler owns the socket. Nothing may write a status
		// onto it again, panic or not.
		w.hijacked = true
	}

	return conn, buffered, e
}

func (w *watched) Flush() {
	if sender, ok := w.ResponseWriter.(http.Flusher); ok {
		sender.Flush()
	}
}

// requestID names one request across the lines it produces. Random rather than
// sequential: a counter would leak how much this instance serves.
func requestID() string {
	raw := make([]byte, 16)
	if _, e := rand.Read(raw); e != nil {
		return ""
	}

	return hex.EncodeToString(raw)
}

/*
observe writes one line for a request that was refused or that took too long,
and nothing for the rest.

Keeping every answered request would be a line per page view on a host whose
journal lands on an SD card. What a status code cannot say — which document,
which reason, how long — is what this keeps.
*/
func observe(next http.Handler, log *slog.Logger, now func() time.Time) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := now()
		seen := &watched{ResponseWriter: w}
		id := requestID()
		if id != "" {
			seen.Header().Set("X-Request-Id", id)
		}

		defer func() {
			if cause := recover(); cause != nil {
				survive(seen, r, log, id, cause)

				return
			}
			report(seen, r, log, id, now().Sub(started))
		}()

		next.ServeHTTP(seen, r)
	})
}

/*
survive keeps a panicking handler from taking the answer with it.

Without this a nil map or a bad index closes the connection with nothing
written anywhere: the client sees a cut line and the host keeps no trace of
the defect. The stack is the whole point — a panic without one names a
goroutine, not the line that broke.
*/
func survive(seen *watched, r *http.Request, log *slog.Logger, id string, cause any) {
	if cause == http.ErrAbortHandler {
		// A handler hanging up on purpose, not a defect: net/http gives this
		// one its own silent path, and catching it would turn an intended
		// silence into a 500.
		panic(cause)
	}
	log.LogAttrs(r.Context(), slog.LevelError, "handler panicked",
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
		slog.String("request", id),
		slog.String("panic", fmt.Sprint(cause)),
		slog.String("stack", string(debug.Stack())),
	)
	// A hijacked connection belongs to the handler: a status written onto it
	// lands in the middle of a framed session. A handler that already
	// answered cannot be given a second status either.
	if seen.hijacked || seen.written {
		return
	}
	problem(seen, http.StatusInternalServerError, "Internal error")
}

// report writes the one line a finished request is worth, or none.
func report(seen *watched, r *http.Request, log *slog.Logger, id string, took time.Duration) {
	// A hijacked connection answered on its own terms; there is no status to
	// report and the session outlives this call.
	if !seen.written {
		return
	}
	if seen.status < http.StatusBadRequest && took < slowRequest {
		return
	}
	message, level := "request refused", slog.LevelWarn
	switch {
	case seen.status >= http.StatusInternalServerError:
		level = slog.LevelError
	case seen.status < http.StatusBadRequest:
		message, level = "request slow", slog.LevelWarn
	}
	log.LogAttrs(r.Context(), level, message,
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
		slog.Int("status", seen.status),
		slog.Int64("ms", took.Milliseconds()),
		slog.String("request", id),
		slog.String("cause", strings.TrimSpace(string(seen.cause))),
	)
}

/*
failed answers like problem, and keeps the error the caller is about to drop:
a 500 that names only its message tells nobody what broke.

The call site is part of the line because the messages are shared — "Read
failed" is written from eight places, and a line without a place names the
shape of the defect rather than its origin. The request name ties this line
to the one observe writes for the same request, which carries the path and
the duration.

The client still gets the message alone: what the database said about this
server's insides is for the journal.
*/
func failed(w http.ResponseWriter, status int, msg string, cause error) {
	written := []any{"error", cause, "at", callsite(2)}
	if id := w.Header().Get("X-Request-Id"); id != "" {
		written = append(written, "request", id)
	}
	slog.Error(msg, written...)
	problem(w, status, msg)
}

// callsite names the line that decided a refusal, as file:line.
func callsite(skip int) string {
	_, file, line, ok := runtime.Caller(skip)
	if !ok {
		return "unknown"
	}

	return path.Base(file) + ":" + strconv.Itoa(line)
}
