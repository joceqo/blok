package cloud

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
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
	status  int
	cause   []byte
	written bool
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

	return taker.Hijack()
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

		next.ServeHTTP(seen, r)

		// A hijacked connection answered on its own terms; there is no status
		// to report and the session outlives this call.
		if !seen.written {
			return
		}
		took := now().Sub(started)
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
	})
}
