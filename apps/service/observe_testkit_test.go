package cloud

import (
	"bytes"
	"log/slog"
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
