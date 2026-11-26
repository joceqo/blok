// Command hold-open lets the Node process tests exercise the Go store's live lease.
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"

	"github.com/JackUait/blok/packages/server/go/v2/internal/collab/journal"
)

func main() {
	store, err := journal.NewStore(os.Args[1], journal.StoreOptions{})
	if err != nil {
		log.Fatal(err)
	}
	outcome, session, err := store.Open(context.Background(), "inspect-example")
	if err != nil || outcome != journal.Opened {
		log.Fatalf("open: outcome=%v err=%v", outcome, err)
	}
	fmt.Println(session.OpenResult().Head.DurableThrough)
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		log.Fatal(err)
	}
	if err := session.Close(); err != nil {
		log.Fatal(err)
	}
}
