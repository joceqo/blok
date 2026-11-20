package cloud

import "testing"

// The service trims a trailing slash before comparing origins; the Blok engine
// compares exactly. Handing it an untrimmed PUBLIC_URL meant every collaboration
// socket was refused with "origin not allowed" while ordinary API calls passed,
// which reads as "offline, not saved" with nothing in the console.
func TestAllowedOriginsTrimsThePublicURL(t *testing.T) {
	got := allowedOrigins(Config{PublicURL: "https://blok.example.test/", AllowedOrigins: []string{"tauri://localhost"}})
	want := []string{"https://blok.example.test", "tauri://localhost"}

	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
