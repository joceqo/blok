package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"sync"
	"testing"
)

func TestRowBodyMigrationReportsSkippedRowsAndDryRunDoesNotTransfer(t *testing.T) {
	ctx, _, cfg := opsFixture(t)
	ops := migrateThenOperate(t, ctx, cfg)
	if _, err := ops.DB.Exec(ctx, `INSERT INTO workspaces(id,slug,name) VALUES('row-ws','row-ws','Rows');
		INSERT INTO pages(id,workspace_id,metadata,content) VALUES('row-source','row-ws','{"id":"row-source","title":"Tasks","position":0}',
		'{"blocks":[{"id":"db","type":"database","data":{},"content":["row","nested","already","template"]},
		{"id":"row","type":"database-row","parent":"db","data":{"properties":{}},"content":["body"]},
		{"id":"body","type":"paragraph","parent":"row","data":{"text":"Move me"}},
		{"id":"nested","type":"database-row","parent":"db","data":{},"content":["inner-db"]},
		{"id":"inner-db","type":"database","parent":"nested","data":{}},
		{"id":"already","type":"database-row","parent":"db","data":{"pageId":"other-page"}},
		{"id":"template","type":"database-row","parent":"db","data":{"template":true}}]}')`); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := blokctlRows(ctx, ops, []string{"migrate", "row-source"}, &out); err != nil {
		t.Fatal(err)
	}
	var report rowBodyMigrationReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Mode != "dry-run" || report.Rows != 1 || report.Blocks != 1 || len(report.Skipped) != 3 {
		t.Fatalf("migration scope was misreported: %s", out.String())
	}
	var pages, migrations int
	if err := ops.DB.QueryRow(ctx, `SELECT count(*) FROM pages`).Scan(&pages); err != nil {
		t.Fatal(err)
	}
	if err := ops.DB.QueryRow(ctx, `SELECT count(*) FROM row_body_migrations`).Scan(&migrations); err != nil {
		t.Fatal(err)
	}
	if pages != 1 || migrations != 0 {
		t.Fatalf("dry run transferred data: pages=%d migrations=%d", pages, migrations)
	}
	out.Reset()
	if err := blokctlRows(ctx, ops, []string{"migrate", "row-source", "--apply"}, &out); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := ops.DB.QueryRow(ctx, `SELECT state FROM row_body_migrations WHERE source_id='row-source'`).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "complete" {
		t.Fatalf("migration did not finish: %s", state)
	}
	var source, body json.RawMessage
	if err := ops.DB.QueryRow(ctx, `SELECT content FROM pages WHERE id='row-source'`).Scan(&source); err != nil {
		t.Fatal(err)
	}
	row := rowPlanBlock(t, rowPlanJSON(t, source), "row")
	pageID := row["data"].(map[string]any)["pageId"].(string)
	if err := ops.DB.QueryRow(ctx, `SELECT content FROM pages WHERE id=$1`, pageID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if text, _ := json.Marshal(rowPlanBlock(t, rowPlanJSON(t, body), "body")["data"]); !bytes.Contains(text, []byte(`"text":"Move me"`)) {
		t.Fatal("destination lost content")
	}
	out.Reset()
	if err := blokctlRows(ctx, ops, []string{"migrate", "row-source", "--resume"}, &out); err != nil {
		t.Fatal(err)
	}
	if err := ops.DB.QueryRow(ctx, `SELECT count(*) FROM pages`).Scan(&pages); err != nil {
		t.Fatal(err)
	}
	if pages != 2 {
		t.Fatalf("resume created duplicates: %d", pages)
	}
	// Simulate process death after resetting the journal but before completing the marker.
	if _, err := ops.DB.Exec(ctx, `UPDATE row_body_migrations SET state='prepared',completed_at=NULL WHERE source_id='row-source'`); err != nil {
		t.Fatal(err)
	}
	if err := blokctlRows(ctx, ops, []string{"migrate", "row-source", "--resume"}, &out); err != nil {
		t.Fatal(err)
	}
	host, err := New(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	restarted, err := newRowBodyRuntime(cfg, http.HandlerFunc(host.document))
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.close()
	got, err := restarted.read(ctx, "row-source")
	if err != nil {
		t.Fatal(err)
	}
	if rowPlanBlock(t, rowPlanJSON(t, got.Document), "row")["data"].(map[string]any)["pageId"] != pageID {
		t.Fatal("restart restored old body tree")
	}
	if err := restarted.drain(ctx); err != nil {
		t.Fatal(err)
	}
}

// Reset hydrates and flushes the old journal even in a fresh manager. The
// maintenance endpoint must acknowledge that projection without overwriting the
// transactionally prepared source, then seed the new lineage from that source.
func TestRowBodyMaintenanceResetPreservesPreparedSource(t *testing.T) {
	ctx := context.Background()
	cfg := Config{DataDirectory: t.TempDir(), InternalSecret: "maintenance-internal-secret-32-characters"}
	before := json.RawMessage(`{"blocks":[{"id":"p","type":"paragraph","data":{"text":[{"text":"Before"}]}}]}`)
	after := json.RawMessage(`{"blocks":[{"id":"p","type":"paragraph","data":{"text":[{"text":"After"}]}}]}`)
	var mu sync.Mutex
	document := append(json.RawMessage(nil), before...)
	endpoint := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+cfg.InternalSecret {
			t.Error("maintenance endpoint missing internal authorization")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodGet {
			jsonOut(w, 200, map[string]any{"data": document, "version": "0"})
			return
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		document = raw
		jsonOut(w, 200, map[string]string{"version": "1"})
	})
	first, err := newRowBodyRuntime(cfg, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := first.read(ctx, "source")
	if err != nil {
		first.close()
		t.Fatal(err)
	}
	if err := first.drain(ctx); err != nil {
		first.close()
		t.Fatal(err)
	}
	first.close()
	mu.Lock()
	document = append(json.RawMessage(nil), after...)
	mu.Unlock()
	protected := rowBodyMigrationEndpoint(endpoint, "source", after, cfg.InternalSecret)
	second, err := newRowBodyRuntime(cfg, protected)
	if err != nil {
		t.Fatal(err)
	}
	defer second.close()
	if err := second.reset(ctx, "source"); err != nil {
		t.Fatal(err)
	}
	got, err := second.read(ctx, "source")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(got.Document, []byte(`"text":"After"`)) {
		t.Fatalf("reset seeded old journal instead of prepared body: %s", got.Document)
	}
	if got.Head == "" || got.Head == initial.Head {
		t.Fatal("reset did not change source lineage")
	}
	if err := second.drain(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(rowPlanJSON(t, document), rowPlanJSON(t, after)) {
		t.Fatalf("reset/drain overwrote prepared source: %s", document)
	}
}

func TestRowBodyMaintenanceEndpointDoesNotFreezeOtherDocuments(t *testing.T) {
	called := false
	underlying := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(202) })
	protected := rowBodyMigrationEndpoint(underlying, "source", json.RawMessage(`{"blocks":[]}`), "secret")
	request, _ := http.NewRequest(http.MethodPut, "http://localhost/internal/documents/other", nil)
	response := &rowMigrationResponse{header: make(http.Header)}
	protected.ServeHTTP(response, request)
	if !called || response.code != 202 {
		t.Fatal("unrelated document writes were intercepted")
	}
}

type rowMigrationResponse struct {
	header http.Header
	code   int
}

func (w *rowMigrationResponse) Header() http.Header         { return w.header }
func (w *rowMigrationResponse) WriteHeader(code int)        { w.code = code }
func (w *rowMigrationResponse) Write(p []byte) (int, error) { return len(p), nil }

func TestRowBodyMigrationLeavesUnconvertedLegacyBlobsInline(t *testing.T) {
	input := json.RawMessage(`{"blocks":[{"id":"db","type":"database","data":{},"content":["r"]},{"id":"r","type":"database-row","parent":"db","data":{"properties":{"body":{"blocks":[{"type":"paragraph","data":{"text":"Legacy"}}]}}}}]}`)
	_, pages, report, err := planRowBodyMigration("source", input)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 0 || len(report.Skipped) != 1 || report.Skipped[0].Reason != "legacy-body" {
		t.Fatalf("unconverted legacy body would disappear: %+v", report)
	}
}
