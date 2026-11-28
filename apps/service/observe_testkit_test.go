package cloud

import (
	"bytes"
	"log/slog"
	"testing"
	"time"
)

// testLogger captures what observe writes, as the JSON a collector would read.
func testLogger() (*slog.Logger, *bytes.Buffer) {
	written := &bytes.Buffer{}

	return slog.New(slog.NewJSONHandler(written, nil)), written
}

// stoppedClock answers the same instant until it is read a second time, then
// jumps by step — so a handler that does nothing still takes `step`.
func stoppedClock(step time.Duration) func() time.Time {
	at := time.Unix(0, 0).UTC()
	first := true

	return func() time.Time {
		if first {
			first = false

			return at
		}

		return at.Add(step)
	}
}

/*
captureDefaultLog points the default logger at a buffer for one test.

failed() writes through slog.Default() because ninety call sites cannot each
carry a logger; a test that wants to read what they wrote has to borrow it.
*/
func captureDefaultLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	log, written := testLogger()
	before := slog.Default()
	slog.SetDefault(log)
	t.Cleanup(func() { slog.SetDefault(before) })

	return written
}
