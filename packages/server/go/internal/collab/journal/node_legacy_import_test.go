package journal

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/JackUait/blok/packages/server/go/v2/internal/collab/workingset"
)

// Generates the source with the actual Go codec and reopens it with the actual
// Go store after two Node restarts and a change continuing the original Yjs IDs.
func TestNodeImportsGoWorkingSetWithoutChangingItsIdentity(t *testing.T) {
	script := os.Getenv("BLOK_TEST_NODE_WORKING_SET")
	if script == "" {
		t.Skip("set BLOK_TEST_NODE_WORKING_SET to the built room's test/legacy-import.mjs")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, "node", script, "--frames").Output()
	if err != nil {
		t.Fatal(err)
	}
	var updates [][]byte
	if err := json.Unmarshal(raw, &updates); err != nil || len(updates) != 3 {
		t.Fatalf("expected three Yjs updates: %v", err)
	}
	section, err := workingset.EncodeFrames(updates[:2])
	if err != nil {
		t.Fatal(err)
	}
	tag := workingset.Tag{Format: 2, Epoch: 121, Lineage: "00112233445566778899aabbccddeeff"}
	source, err := workingset.EncodeDocument(tag, section)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"fresh", "known"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			const page = "legacy-test"
			path := filepath.Join(root, workingset.DocKey(page))
			if err := os.WriteFile(path, source, 0600); err != nil {
				t.Fatal(err)
			}
			cmd := exec.CommandContext(ctx, "node", script, mode, root, page, tag.Lineage)
			cmd.Stdin = bytes.NewReader(updates[2])
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("Node migration: %v\n%s", err, output)
			}
			store, err := NewStore(root, StoreOptions{})
			if err != nil {
				t.Fatal(err)
			}
			outcome, session, err := store.Open(ctx, page)
			if err != nil || outcome != Opened {
				t.Fatalf("Go reopen: outcome=%v err=%v", outcome, err)
			}
			defer session.Close()
			got := session.OpenResult()
			if got.Head == nil || got.Head.Format != tag.Format || got.Head.Epoch != tag.Epoch ||
				got.Head.Lineage != tag.Lineage || got.Head.DurableThrough != 1 || len(got.Baseline) != 2 ||
				!bytes.Equal(got.Baseline[0], updates[0]) || !bytes.Equal(got.Baseline[1], updates[1]) ||
				len(got.Tail) != 1 || !bytes.Equal(got.Tail[0].Update, updates[2]) {
				t.Fatalf("Go read back a different baseline, operation or tag: %+v", got.Head)
			}
			original, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(original, source) {
				t.Fatalf("legacy source was modified: %v", err)
			}
		})
	}
}
