package cloud

import (
	"testing"
	"time"
)

// A client asks for how long its token should live. Anything outside the
// offered set is refused rather than silently falling back to a default,
// so a typo never mints a longer-lived credential than intended.
func TestTokenLifetime(t *testing.T) {
	day := 24 * time.Hour
	for _, tc := range []struct {
		code string
		want time.Duration
	}{
		{"", 90 * day},
		{"1d", day},
		{"7d", 7 * day},
		{"30d", 30 * day},
		{"90d", 90 * day},
		{"1y", 365 * day},
		{"never", neverExpires},
	} {
		got, ok := tokenLifetime(tc.code)
		if !ok {
			t.Fatalf("%q refused", tc.code)
		}
		if got != tc.want {
			t.Fatalf("%q: got %v, want %v", tc.code, got, tc.want)
		}
	}
	for _, code := range []string{"2d", "0", "forever", "-1d", "1D", " 7d", "365d", "infinite"} {
		if _, ok := tokenLifetime(code); ok {
			t.Fatalf("%q accepted", code)
		}
	}
}

// "never" must outlive any plausible deployment: the column stays NOT NULL and
// every lookup keeps its `expires_at>now()` filter, so a sentinel is what makes
// a non-expiring token honest rather than a special case in four queries.
func TestNeverExpiresOutlivesACentury(t *testing.T) {
	if neverExpires < 100*365*24*time.Hour {
		t.Fatalf("sentinel too short: %v", neverExpires)
	}
}
