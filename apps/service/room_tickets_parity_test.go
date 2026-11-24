package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"
)

// The same page tree, memberships and session digests back both real HTTP hosts.
// Build apps/service-node first and point this variable at its parity script.
func TestNodeShellTicketAndAdmissionParity(t *testing.T) {
	script := os.Getenv("BLOK_TEST_NODE_TICKET_PARITY")
	if script == "" {
		t.Skip("set BLOK_TEST_NODE_TICKET_PARITY to apps/service-node/test/room-tickets-parity.mjs")
	}
	w := newReadsWorld(t)
	ctx, cancel := context.WithTimeout(w.ctx, 30*time.Second)
	defer cancel()
	config := w.service.Config
	input, err := json.Marshal(map[string]string{
		"database": config.DatabaseURL, "internal": config.InternalSecret,
		"ticket": config.TicketSecret, "goOrigin": w.server.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, "node", script)
	cmd.Stdin = bytes.NewReader(input)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Node/Go ticket parity: %v\n%s", err, output)
	} else {
		t.Log(string(output))
	}
}
